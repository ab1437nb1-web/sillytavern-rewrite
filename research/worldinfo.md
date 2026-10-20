# SillyTavern World Info (Lorebook) — Re-implementation Spec

Target: SillyTavern **1.19.0** (`package.json` version `1.19.0`, commit `06bde939f`, branch `main`).

Authoritative source: `public/scripts/world-info.js` (6408 lines). All line numbers below refer to that
file unless stated otherwise. Secondary sources: `src/endpoints/worldinfo.js` (server I/O),
`public/script.js` (chat→scan-array, prompt consumers), `public/scripts/openai.js` (chat-completion
placement + `formatWorldInfo`), `public/scripts/authors-note.js` (AN hijack), `public/index.html`
(position `<select>` labels), `default/content/settings.json` (defaults), `default/content/Eldoria.json`
(example book).

Everything in this document is read from source; anything that could not be resolved is in
[§15 Open questions](#15-open-questions).

---

## 0. Executive summary of the pipeline

```
chat messages (reversed) ─┐
character/persona fields ─┼─► WorldInfoBuffer ─┐
extension prompts (.scan) ┘                    │
                                               ├─► checkWorldInfo()
all entries of all active books (flattened,    │     1. timed-effects pre-pass
sorted) ───────────────────────────────────────┘     2. loop: match → groups → probability → budget
                                                     3. recursion / min-activations passes
                                                     4. build buckets by position
                                                              │
        { worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries, ANBeforeEntries, ANAfterEntries, outletEntries }
```

There is **no "World Info" header, no separator, no per-entry name prefix**. Entries are simply
concatenated with `\n` (see §11).

---

## 1. Constants and enums (verbatim)

```js
// world-info.js:27-60
export const world_info_insertion_strategy = { evenly: 0, character_first: 1, global_first: 2 };
export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 };

// world-info.js:855-869
export const world_info_position = {
    before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
};
export const wi_anchor_position = { before: 0, after: 1 };

// world-info.js:96-100
export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;
const MAX_COMMENT_LENGTH = 100;            // UI only
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

// script.js:494-498
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

// constants.js:36-43
export const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
```

`world_info_position` is confirmed by the UI `<select name="position">` in `public/index.html:7173ff`:
`0 = ↑Char (Before Char Defs)`, `1 = ↓Char`, `5 = ↑EM`, `6 = ↓EM`, `2 = ↑AN`, `3 = ↓AN`,
`4 = @D` with `data-role` `0|1|2` (System/User/AI), `7 = Outlet`.

**Correction to a common assumption:** 5/6 are **not** "depth as user / depth as assistant" in 1.19.0.
Depth role is expressed by `position: 4` **plus** the `role` field. 5/6 are example-message anchors.

---

## 2. Global settings

Module-scope defaults (`world-info.js:69-82`) vs. shipped defaults (`default/content/settings.json` →
`world_info_settings`):

| Setting | Module default | Shipped `settings.json` | Meaning |
|---|---|---|---|
| `world_info_depth` | `2` | `2` | Default scan depth in **messages** |
| `world_info_min_activations` | `0` | absent → `0` | Keep widening the scan until N entries activate |
| `world_info_min_activations_depth_max` | `0` | absent → `0` | Max depth for the widening (0 = unbounded, still capped by chat length) |
| `world_info_budget` | `25` | `25` | **Percent** of `maxContext` (not tokens) |
| `world_info_budget_cap` | `0` | `0` | Absolute token ceiling applied after the %; `0` = off |
| `world_info_include_names` | `true` | `true` | Prefix scanned messages with `"Name: "` |
| `world_info_recursive` | `false` | `true` | Enable recursion pass |
| `world_info_overflow_alert` | `false` | `false` | `toastr.warning` on budget overflow |
| `world_info_case_sensitive` | `false` | `false` | Global default for `entry.caseSensitive` |
| `world_info_match_whole_words` | `false` | `true` | Global default for `entry.matchWholeWords` |
| `world_info_use_group_scoring` | `false` | absent → `false` | Global default for group scoring |
| `world_info_character_strategy` | `1` (character_first) | `1` | Ordering of character vs global books |
| `world_info_max_recursion_steps` | `0` | absent → `0` | Hard cap on scan passes (0 = uncapped) |

`setWorldInfoSettings` (917-1033) migrates legacy values: `world_info_budget > 100` is reset to `25`
(946-948). `world_info` (the selected global books) lives in `settings.world_info.globalSelect`
(array of book names), migrated from a legacy string.

---

## 3. Entry data model

### 3.1 Canonical field definition (`newWorldInfoEntryDefinition`, 4082-4125)

`newWorldInfoEntryTemplate` (4127-4129) is the same object minus `excludeFromTemplate` fields, mapping
field → default. A new entry is `{ uid, ...template }` (4145).

| Field | Default | Type | Meaning / where used |
|---|---|---|---|
| `uid` | — (assigned) | number | Per-book identity. Assigned by `getFreeWorldEntryUid` (4395-4409): smallest integer `0..999_999` not present as a key. Used for dedupe key `"${world}.${uid}"` and for the file's `entries` key. |
| `key` | `[]` | string[] | Primary keywords. Each element may be plain text or `/regex/flags`. |
| `keysecondary` | `[]` | string[] | Secondary keywords, evaluated per `selectiveLogic`. |
| `comment` | `''` | string | Entry title/memo. **Not injected.** Max 100 chars in UI. |
| `content` | `''` | string | The text injected into the prompt. Macros substituted at activation (5058). |
| `constant` | `false` | boolean | Force-activate without any key match (4893). |
| `vectorized` | `false` | boolean | **UI only** (tri-state constant/normal/vectorized, 3277-3314). No effect anywhere in the engine. Vector retrieval is a separate extension. |
| `selective` | `true` | boolean | If falsy, `keysecondary` is ignored entirely (4924-4935). |
| `selectiveLogic` | `0` = `AND_ANY` | enum 0-3 | Secondary-key logic (§6). Read as `entry.selectiveLogic ?? 0` (4939). |
| `addMemo` | `false` | boolean | UI only (auto-fill `comment` from keys). |
| `order` | `100` | number | Insertion priority. **Higher = earlier in prompt and higher budget priority** (§10, §11). |
| `position` | `0` | enum 0-7 | Insertion bucket (§11). |
| `disable` | `false` | boolean | Checked with `entry.disable == true` (4801). |
| `ignoreBudget` | `false` | boolean | Exempt from the token budget (5017-5026, 5061). |
| `excludeRecursion` | `false` | boolean | Entry cannot activate *during* a recursion pass (4870). Only honoured when `world_info_recursive` is true. |
| `preventRecursion` | `false` | boolean | Entry may activate, but its `content` is not appended to the recursion buffer (5080). |
| `matchPersonaDescription` | `false` | boolean | Add persona description to this entry's scan text (299-301). |
| `matchCharacterDescription` | `false` | boolean | Add character description (302-304). |
| `matchCharacterPersonality` | `false` | boolean | Add personality (305-307). |
| `matchCharacterDepthPrompt` | `false` | boolean | Add character depth prompt / notes (308-310). |
| `matchScenario` | `false` | boolean | Add scenario (311-313). |
| `matchCreatorNotes` | `false` | boolean | Add creator notes (314-316). |
| `delayUntilRecursion` | `0` | number | `0` = normal. `true` is coerced to `1`. Levels gate recursion passes (4754-4762, 4860-4868). |
| `probability` | `100` | number | Percent chance, `0..100`, rolled with `Math.random()*100 <= probability` (5041-5045). |
| `useProbability` | `true` | boolean | Master switch for the roll. |
| `depth` | `4` (`DEFAULT_DEPTH`) | number | Chat depth for `position: 4` (§11). |
| `outletName` | `''` | string | Outlet key for `position: 7`. Empty ⇒ entry dropped with a warning (5249-5252). |
| `group` | `''` | string | Inclusion group(s), comma-separated, split with `/,\s*/` (5392). |
| `groupOverride` | `false` | boolean | Win the group by `order` instead of by weight (5444-5449). |
| `groupWeight` | `100` (`DEFAULT_WEIGHT`) | number | Weight for the weighted-random pick (5452). |
| `scanDepth` | `null` | number \| null | Per-entry scan depth override. `null` ⇒ `world_info_depth + skew`. `0` yields an **empty** scan buffer (§5). |
| `caseSensitive` | `null` | boolean \| null | Per-entry override of `world_info_case_sensitive`. |
| `matchWholeWords` | `null` | boolean \| null | Per-entry override of `world_info_match_whole_words`. |
| `useGroupScoring` | `null` | boolean \| null | Per-entry group-scoring switch (§8). |
| `automationId` | `''` | string | Automation/Quick Reply binding. **No engine effect.** |
| `role` | `0` (`SYSTEM`) | enum 0-2 | Only meaningful for `position: 4`; UI sets `null` for other positions (3431). |
| `sticky` | `null` | number \| null | Turns to stay forced-active after activating (§7). |
| `cooldown` | `null` | number \| null | Turns to stay suppressed after sticky ends / after activation (§7). |
| `delay` | `null` | number \| null | Absolute chat-length gate: suppressed while `chat.length < delay` (§7). |
| `triggers` | `[]` | string[] | Generation-type whitelist, filtered to `GENERATION_TYPE_TRIGGERS` (4124). Empty = all. |
| `characterFilter` | *not in template* | object | `{ isExclude: boolean, names: string[], tags: string[] }`, created by `addMissingWorldInfoFields` (2125-2132). Filters by character avatar filename / tag map. |
| `displayIndex` | — | number | Editor drag-order only (custom sort). Not used by the engine. |
| `extensions` | — | object | Raw card `extensions` blob kept for round-tripping (5667). |
| `world` | *injected at load* | string | Book name, added when entries are flattened (4515/4535/4557/4583). |
| `decorators` | *injected at load* | string[] | Result of `parseDecorators(content)` (§4.3). |
| `hash` | *injected at load* | number | `getStringHash(JSON.stringify(entry))` **after** decorator stripping (4628-4634). Used as timed-effect identity (§7). |

`excludeFromTemplate: true` fields (`characterFilterNames`, `characterFilterTags`,
`characterFilterExclude`, 4121-4123) exist only to drive the editor and are never written to file.

### 3.2 Important: activation does **not** normalise entries

`addMissingWorldInfoFields` (2104-2136) is called only from the editor path (`displayWorldEntries`,
2370). The scanner reads raw objects and relies on `??` fallbacks and truthiness, so a missing field
behaves like its default in almost all cases. Two consequences a re-implementation must keep:

* `entry.selectiveLogic ?? 0`, `entry.matchWholeWords ?? world_info_match_whole_words`, etc. must be
  used, not `entry.x || default` — because `0`, `false`, `''` are all legitimate values
  (`caseSensitive: false` must override a global `true`).
* `entry.decorators` and `entry.hash` **must** exist before scanning; they are added by
  `getSortedEntries`, not by the file loader.

---

## 4. File shape, loading, ordering

### 4.1 On-disk format

```json
{
  "entries": {
    "0": { "uid": 0, "key": ["eldoria", "wood"], "keysecondary": [], "comment": "eldoria",
           "content": "...", "constant": false, "selective": true, "order": 100,
           "position": 0, "disable": false, "displayIndex": 0, "addMemo": true,
           "group": "", "groupOverride": false, "groupWeight": 100,
           "sticky": 0, "cooldown": 0, "delay": 0, "probability": 100, "depth": 4,
           "useProbability": true, "role": null, "vectorized": false,
           "excludeRecursion": false, "preventRecursion": false,
           "delayUntilRecursion": false, "scanDepth": null, "caseSensitive": null,
           "matchWholeWords": null, "useGroupScoring": null, "automationId": "" }
  },
  "name": "optional display name",
  "extensions": {}
}
```

* `entries` is a plain object keyed by the uid **as a string**. Numeric-like keys enumerate in
  ascending numeric order in JS, which is why the editor relies on `displayIndex`/`order` instead.
* Only `entries` is required. `src/endpoints/worldinfo.js:116` and `:144` reject files without it
  (`"File must contain a world info entries list"` / `"Is not a valid world info file"`).
* `name` and `extensions` are optional metadata read by `/api/worldinfo/list`
  (`file_id`, `name`, `extensions`).
* File name on disk: `sanitize-filename(`${name}.json`)` inside `directories.worlds`
  (`src/endpoints/worldinfo.js:24-25`). Import writes `path.parse(sanitize(originalname)).name + ".json"`.
* Save: `JSON.stringify(data, null, 4)` with `write-file-atomic` (154).
* `default/content/Eldoria.json` is a real example: `{ "entries": { "0".."3" } }`, no `name`, entries
  carry a legacy `displayIndex` and omit `characterFilter`/`triggers`/`match*` fields entirely —
  exactly the "sparse entry" case that the `??`-based defaults must survive.

### 4.2 Where the scanned entry set comes from (`getSortedEntries`, 4590-4644)

Four sources are gathered in parallel:

| Source | Function | Books |
|---|---|---|
| Chat lore | `getChatLore` (4544) | `chat_metadata.world_info` (one book), skipped if it is also a global book |
| Persona lore | `getPersonaLore` (4564) | `power_user.persona_description_lorebook`, skipped if it equals chat world or is global |
| Character lore | `getCharacterLore` (4475) | `character.data.extensions.world` + `world_info.charLore[]` extraBooks for that avatar; each skipped if already global/chat/persona |
| Global lore | `getGlobalLore` (4527) | every name in `selected_world_info` |

Every entry is flattened as `{ uid, world: worldName, ...rest }` (4515 et al.) — `world` is stamped
here, `uid` comes from the entry's own `uid` property (not the object key).

Concatenation order (4606-4625), which is also the **budget/priority order**:

```
strategy 0 evenly:          [...globalLore, ...characterLore].sort(order desc)
strategy 1 character_first: [...characterLore.sort(desc), ...globalLore.sort(desc)]
strategy 2 global_first:    [...globalLore.sort(desc), ...characterLore.sort(desc)]
then:  [...chatLore.sort(desc), ...personaLore.sort(desc), ...above]
```

`sortFn = (a, b) => b.order - a.order` (line 88) — **descending order**.

Then each entry gets `decorators` + stripped `content`, then `hash` (4627-4634). The result is
`structuredClone`d and cached per call; `getSortedEntries` is invoked on every `checkWorldInfo`
(4744), so caching books (not the sorted list) is the ST strategy (`worldInfoCache`, 882).

### 4.3 Content decorators (`parseDecorators`, 4652-4698)

If `content` starts with `@@`, leading lines beginning with `@@` are consumed as decorators:

* `@@activate` → force-activate this entry (checked at 4875, **after** timed-effect/recursion gates).
* `@@dont_activate` → suppress (4881, after `@@activate`).
* Unknown `@@…` line → `fallbacked = true`, treated as content and stops decorator collection.
* `@@@known` is an escaped form (one `@` is stripped, decorator still recognised).

Only these two decorators exist (`KNOWN_DECORATORS`). The decorator lines are removed from `content`
before hashing and before injection.

---

## 5. The scan buffer (`WorldInfoBuffer`, 199-474)

### 5.1 Construction

`new WorldInfoBuffer(chat, globalScanData)` where `chat` is the **reversed** core chat
(`public/script.js:4624`):

```js
const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
```

`#initDepthBuffer` (250-260): for `depth` in `0..MAX_SCAN_DEPTH-1`, if `messages[depth]` is truthy,
store `messages[depth].trim()`; break when `depth === messages.length - 1`. So index `0` = newest
message, `1` = one before, etc. Empty messages leave holes in the array.

`globalScanData` (built at `script.js:4626-4634`) is:

```js
{ personaDescription, characterDescription, characterPersonality, characterDepthPrompt,
  scenario, creatorNotes, trigger }   // trigger ∈ GENERATION_TYPE_TRIGGERS, else 'normal'
```

Its frozen default is `defaultGlobalScanData` (186-194) with `trigger: 'normal'` and all strings `''`.

Before scanning, `checkWorldInfo` also pushes **injectable** extension prompts into the buffer
(4719-4726):

```js
for (const key of Object.keys(context.extensionPrompts))
    if (context.extensionPrompts[key]?.scan) buffer.addInject(await getExtensionPromptByName(key));
```

(Author's Note is one such prompt when "Allow WI scan" is on.)

### 5.2 `get(entry, scanState)` — the haystack for one entry (279-328)

```js
const MATCHER = '\x01';
const JOINER  = '\n' + MATCHER;

let depth = entry.scanDepth ?? this.getDepth();     // getDepth() = world_info_depth + skew
if (depth <= this.#startDepth) return '';           // #startDepth is ALWAYS 0  → depth 0 = empty buffer
if (depth < 0)  { console.error(...); return ''; }
if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;

let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);
```

So `scanDepth = N` ⇒ the **N newest messages**. `scanDepth = 0` (or `world_info_depth = 0` with no
skew) ⇒ **empty string**, i.e. only constant/`@@activate`/sticky entries can fire.

Then, only when the corresponding flag is set **and** the value is non-empty, each field is appended
with the same `JOINER` (299-316), in this exact order:

1. `personaDescription` (`matchPersonaDescription`)
2. `characterDescription` (`matchCharacterDescription`)
3. `characterPersonality` (`matchCharacterPersonality`)
4. `characterDepthPrompt` (`matchCharacterDepthPrompt`)
5. `scenario` (`matchScenario`)
6. `creatorNotes` (`matchCreatorNotes`)
7. `#injectBuffer` joined (always, no flag)
8. `#recurseBuffer` joined — **unless** `scanState === scan_state.MIN_ACTIVATIONS` (323)

`\x01` exists so adjacent messages cannot be accidentally glued into a phrase; it is part of the
haystack and is why a raw regex may match across the `\n\x01` boundary (documented quirk).

### 5.3 Key matching (`matchKeys`, 337-366)

```js
matchKeys(haystack, needle, entry) {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) return keyRegex.test(haystack);        // regex wins over everything

    haystack = this.#transformString(haystack, entry);   // lowercase unless case-sensitive
    const transformedString = this.#transformString(needle, entry);
    const matchWholeWords = entry.matchWholeWords ?? world_info_match_whole_words;

    if (matchWholeWords) {
        const keyWords = transformedString.split(/\s+/);
        if (keyWords.length > 1) return haystack.includes(transformedString);
        const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
        if (regex.test(haystack)) return true;
    } else {
        return haystack.includes(transformedString);
    }
    return false;
}
```

Notes:
* `#transformString` (268-271) uses `entry.caseSensitive ?? world_info_case_sensitive`; `false` ⇒
  `toLowerCase()` on **both** sides. Regex keys bypass case handling entirely (flags govern it).
* Whole-word mode only applies the boundary regex to **single-token** keys; multi-word keys degrade to
  plain `includes`.
* Boundary class is `\W`, i.e. punctuation/space delimiters — non-ASCII letters behave as `\W`
  separators in JS without the `u` flag.
* `escapeRegex` comes from `utils.js`.

`parseRegexFromString` (2901-2926) — **exact** rules for `/pattern/flags`:

```js
let match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);   // must be the whole string
if (!match) return null;
if (pattern.match(/(^|[^\\])\//)) return null;            // unescaped internal "/" → not a regex
pattern = pattern.replace('\\/', '/');                    // only the FIRST occurrence is unescaped
try { return new RegExp(pattern, flags); } catch { return null; }
```

Allowed flags: `g i m s u y`. `/` inside a key must be written `\/`. A key is only a regex if the
**entire** key string is slash-delimited; otherwise it is literal text (commas inside a regex are
allowed by the editor tokenizer, `customTokenizer` 2825-2878).

Macro substitution happens **before** matching: `substituteParams(key)` then `.trim()`
(4914-4917 for primary, 4946-4948 for secondary). Empty results are falsy and never match.

---

## 6. Activation algorithm (the authoritative loop, 4709-5282)

### 6.1 Pre-loop setup

```js
const buffer       = new WorldInfoBuffer(chat, globalScanData);
for (extension prompts with .scan) buffer.addInject(...)

let scanState = scan_state.INITIAL;
let count = 0;                      // completed passes
let allActivatedEntries = new Map();// key: `${world}.${uid}`
let failedProbabilityChecks = new Set();
let allActivatedText = '';
let token_budget_overflowed = false;

let budget = Math.round(world_info_budget * maxContext / 100) || 1;   // 4736
if (world_info_budget_cap > 0 && budget > world_info_budget_cap) budget = world_info_budget_cap;

const sortedEntries = await getSortedEntries();
const timedEffects  = new WorldInfoTimedEffects(chat, sortedEntries, isDryRun);
timedEffects.checkTimedEffects();                    // BEFORE scanning

if (sortedEntries.length === 0) return { empty result };
```

Recursion-delay level preparation (4753-4762):

```js
const availableRecursionDelayLevels = [...new Set(sortedEntries
    .filter(e => e.delayUntilRecursion)
    .map(e => e.delayUntilRecursion === true ? 1 : e.delayUntilRecursion))].sort((a,b)=>a-b);
let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
```

### 6.2 Loop skeleton

```js
while (scanState) {                                   // NONE === 0 is falsy → exit
    if (world_info_max_recursion_steps && world_info_max_recursion_steps <= count) break;
    count++;
    let nextScanState = scan_state.NONE;
    let activatedNow  = new Set();

    for (const entry of sortedEntries) { /* §6.3 */ }

    /* sort activatedNow (§6.4) */
    /* filterByInclusionGroups (§8) */
    /* probability + budget + accumulate (§6.5) */

    /* schedule next pass (§6.6) */
}
```

### 6.3 Per-entry gate order (4785-4989) — order is semantically significant

Skip conditions in exact order. `log()` calls are omitted.

| # | Line | Condition | Effect |
|---|---|---|---|
| 1 | 4797 | `failedProbabilityChecks.has(entry) \|\| allActivatedEntries.has(\`${world}.${uid}\`)` | skip |
| 2 | 4801 | `entry.disable == true` | skip |
| 3 | 4807 | `Array.isArray(entry.triggers) && entry.triggers.length` and `!entry.triggers.includes(globalScanData.trigger)` | skip |
| 4 | 4816 | `entry.characterFilter.names.length > 0` → `nameIncluded = names.includes(getCharaFilename())`; `filtered = isExclude ? nameIncluded : !nameIncluded` | skip if filtered |
| 5 | 4826 | `entry.characterFilter.tags.length > 0` and a tag map exists for `this_chid`; `includesTag = tagMap.some(t => entry.characterFilter.tags.includes(t))`; same `isExclude` inversion | skip if filtered |
| 6 | 4849 | `isDelay` (timed effect, §7) | skip |
| 7 | 4854 | `isCooldown && !isSticky` | skip |
| 8 | 4860 | `scanState !== RECURSION && entry.delayUntilRecursion && !isSticky` | skip |
| 9 | 4865 | `scanState === RECURSION && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky` | skip |
| 10 | 4870 | `scanState === RECURSION && world_info_recursive && entry.excludeRecursion && !isSticky` | skip |
| 11 | 4875 | `entry.decorators.includes('@@activate')` | **activate** |
| 12 | 4881 | `entry.decorators.includes('@@dont_activate')` | skip |
| 13 | 4886 | `buffer.getExternallyActivated(entry)` (from `WORLDINFO_FORCE_ACTIVATE` / slash command) | **activate with the external object** |
| 14 | 4893 | `entry.constant` | **activate** |
| 15 | 4899 | `isSticky` | **activate** |
| 16 | 4905 | `!Array.isArray(entry.key) \|\| !entry.key.length` | skip |
| 17 | 4911 | `textToScan = buffer.get(entry, scanState)` (computed **once**, outside key loops) | — |
| 18 | 4914 | `primaryKeyMatch = entry.key.find(k => substituteParams(k) && matchKeys(textToScan, sub.trim(), entry))`; none ⇒ skip | — |
| 19 | 4924 | `hasSecondaryKeywords = entry.selective && Array.isArray(keysecondary) && keysecondary.length`; if false ⇒ **activate** | — |
| 20 | 4980 | `matchSecondaryKeys()` per `selectiveLogic`; false ⇒ skip, true ⇒ **activate** | — |

Note gates 8-10 (`delayUntilRecursion`, `excludeRecursion`) run **before** `@@activate`, so
`@@activate` cannot bypass them, but `sticky` can (via the `!isSticky` guards).

### 6.4 Ordering of the freshly activated set (4993-5006)

```js
if (activatedNow.size > 1) {
    const index = new Map(sortedEntries.map((e, i) => [e, i]));
    newEntries = [...activatedNow].sort((a, b) =>
        (isBSticky ? 1 : 0) - (isASticky ? 1 : 0)          // sticky entries first
        || (index.get(a) ?? -1) - (index.get(b) ?? -1));    // then canonical book/order index
} else newEntries = [...activatedNow];
```

This single order drives group selection, probability, budget, and recursion text.

### 6.5 Probability + budget + accumulation (5009-5077)

```js
let newContent = '';
const textToScanTokens = await getTokenCountAsync(allActivatedText);   // 5010, per pass

filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);

let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;

for (const entry of newEntries) {
    ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
    if (token_budget_overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue;   // still an ignoreBudget entry later → skip, keep looking
        break;                              // nothing more to salvage → stop this pass entirely
    }

    if (!verifyProbability()) continue;     // see below

    entry.content = substituteParams(entry.content);
    newContent += `${entry.content}\n`;

    if (!entry.ignoreBudget && (textToScanTokens + await getTokenCountAsync(newContent)) >= budget) {
        token_budget_overflowed = true;     // one-way flag for the rest of the scan
        continue;                           // entry is dropped (not added to allActivatedEntries)
    }
    allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
}
```

`verifyProbability()` (5028-5049):

```js
if (!entry.useProbability || entry.probability === 100) return true;
if (timedEffects.isEffectActive('sticky', entry))        return true;   // no re-roll while sticky
const rollValue = Math.random() * 100;
if (rollValue <= entry.probability) return true;         // <= , not <
failedProbabilityChecks.add(entry);                      // permanent for this scan
return false;
```

Failure is sticky across passes (gate 1). A probability-failed group winner does **not** re-roll the
other group members, because grouping happens before probability.

### 6.6 Scheduling the next pass (5080-5147)

```js
const successfulNewEntries            = newEntries.filter(x => !failedProbabilityChecks.has(x));
const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

// 1) normal recursion
if (world_info_recursive && !token_budget_overflowed && successfulNewEntriesForRecursion.length)
    nextScanState = scan_state.RECURSION;

// 2) a min-activations pass that produced recursion text always gets a recursion pass afterwards
if (world_info_recursive && !token_budget_overflowed
    && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse())
    nextScanState = scan_state.RECURSION;

// 3) min activations (only if nothing else is planned)
const minActivationsNotSatisfied =
    world_info_min_activations > 0 && allActivatedEntries.size < world_info_min_activations;
if (!nextScanState && !token_budget_overflowed && minActivationsNotSatisfied) {
    let over_max = (world_info_min_activations_depth_max > 0
                    && buffer.getDepth() > world_info_min_activations_depth_max)
                || (buffer.getDepth() > chat.length);
    if (!over_max) { nextScanState = scan_state.MIN_ACTIVATIONS; buffer.advanceScan(); }
}

// 4) leftover delay-until-recursion levels
if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
    nextScanState = scan_state.RECURSION;
    currentRecursionDelayLevel = availableRecursionDelayLevels.shift();
}

// 5) carry text into the recursion buffer
const curScanState = scanState;
scanState = nextScanState;
if (scanState) {
    const text = successfulNewEntriesForRecursion.map(x => x.content).join('\n');
    if (text) { buffer.addRecurse(text); allActivatedText = text + '\n' + allActivatedText; }
}
```

Then `event_types.WORLDINFO_SCAN_DONE` is emitted with a mutable state object (5150-5186) whose
`state.next`, `activated.text`, `recursionDelay.currentLevel`, `budget.current` and
`budget.overflowed` are read back from the listeners — extensions can therefore alter the scan.

**Recursion mechanics, precisely:**

* Recursion text = concatenation of the **already-macro-substituted `content`** of every entry that
  survived probability in that pass (and was not `preventRecursion`), including entries that were then
  dropped by the budget (they `continue` without being removed from `newEntries`).
* Everything is joined into one string and appended to the recurse buffer with `\n`; the buffer is
  appended to the haystack with `JOINER` (`\n\x01`), i.e. the recursion text behaves like one extra
  pseudo-message at the end of the scan text.
* The recursion buffer is **not** included in min-activations scans (323).
* Recursion stops when no successful entries remain, or when `token_budget_overflowed`, or when
  `world_info_max_recursion_steps` passes have been completed.
* `count` counts **all** passes, including the initial one, so `world_info_max_recursion_steps = 1`
  allows exactly one pass (no recursion at all).

**`delayUntilRecursion` semantics, precisely:**

* `delayUntilRecursion` truthy ⇒ the entry is suppressed during `INITIAL` and `MIN_ACTIVATIONS` passes
  (gate 8) unless it is sticky.
* During `RECURSION` passes it is suppressed while `entry.delayUntilRecursion > currentRecursionDelayLevel`.
* Levels are collected **once** before the loop and sorted ascending; the lowest level is loaded into
  `currentRecursionDelayLevel` immediately, the rest stay in `availableRecursionDelayLevels`.
* Consequence (quirky, must be replicated): the lowest level does not get its own pass. It is only
  reached in a recursion pass triggered by (1) real recursion, or (2) the *next* level existing
  (step 4). A book whose only delayed entries are at level `1`, with `world_info_recursive = false`
  and nothing else activating, will **never** activate them.

### 6.7 Dry run

`isDryRun` changes behaviour in exactly three places:

1. `getWorldInfoPrompt` does not emit `WORLD_INFO_ACTIVATED` (900).
2. `WorldInfoTimedEffects.checkTimedEffects` skips sticky/cooldown entirely (683-687) — so dry runs do
   **not** see sticky entries and **do** see entries that would be on cooldown.
3. `setTimedEffects` / `setTimedEffect` are no-ops (731, 748-750).

`delay` is still evaluated in dry runs (687).

---

## 7. Timed effects: sticky / cooldown / delay (`WorldInfoTimedEffects`, 479-793)

Storage lives in chat metadata, keyed by `"${world}.${uid}"`:

```js
chat_metadata.timedWorldInfo = {
    sticky:   { "book.3": { hash: 123456789, start: 42, end: 44, protected: false } },
    cooldown: { "book.3": { hash: 123456789, start: 44, end: 46, protected: true  } },
};
```

`delay` is **never stored** — it is derived every time.

### 7.1 Counters (`#getEntryTimedEffect`, 604-611)

```js
{ hash: entry.hash, start: chat.length, end: chat.length + Number(entry[type]), protected: !!isProtected }
```

`chat.length` is the length of the **reversed core chat** (i.e. number of core messages), not the
message id. One generation normally adds one message, so one turn = `+1`.

### 7.2 Per-pass evaluation (`#checkTimedEffectOfType`, 619-660)

For `sticky` then `cooldown` (skipped on dry runs):

| Condition (in order) | Action |
|---|---|
| `chat.length <= start && !protected` | delete effect ("chat not advanced" — regeneration/swipe drops it, so it can re-roll) |
| entry not found by `hash` | delete only if `chat.length >= end`, else keep silently |
| `!entry[type]` (value removed/nulled) | delete |
| `chat.length >= end` | delete, fire `onEnded` |
| otherwise | push to buffer ⇒ **active** |

`isEffectActive(type, entry)` (777-783) compares **by `hash` only** (not by key):
`buffer[type].some(x => x.hash === entry.hash)`.
Because `hash` is `JSON.stringify(entry)`, **any edit to an entry invalidates its running timed
effects**.

`#checkDelayEffect` (666-677) — independent of metadata:

```js
for (const entry of entries) if (entry.delay && chat.length < entry.delay) buffer.delay.push(entry);
```

`entry.delay = N` means "suppressed until the chat has at least N messages" — an absolute gate, not
per-activation.

### 7.3 Hook: sticky → cooldown (`#onEnded.sticky`, 518-529)

When a sticky effect expires **and** `entry.cooldown` is non-zero, a cooldown effect is created
immediately with `protected: true` (`start = chat.length`, `end = start + cooldown`) and the entry is
pushed into the cooldown buffer for the current evaluation, so the cooldown starts on the very turn the
sticky ended.

### 7.4 Writing effects (`setTimedEffects`, 730-736; called at 5274)

For every entry in `allActivatedEntries` (all passes, after group/probability/budget filtering):

```js
#setTimedEffectOfType('sticky'|'cooldown', entry) {
    if (!entry[type]) return;
    const key = `${entry.world}.${entry.uid}`;
    if (!chat_metadata.timedWorldInfo[type][key]) {   // do NOT refresh an existing effect
        chat_metadata.timedWorldInfo[type][key] = { hash, start: chat.length, end: chat.length + Number(entry[type]), protected: false };
    }
}
```

### 7.5 Net turn semantics (must be replicated exactly)

With `start = L` at activation and `end = L + N`:

* Turn `L` (the activation turn): effect written, not yet "active" during that scan.
* Turns `L+1 … L+N-1`: `chat.length < end` ⇒ active.
* Turn `L+N`: `chat.length >= end` ⇒ expired and (for sticky) converted to cooldown.

So `sticky: N` keeps the entry forced-active for **N-1 subsequent turns**, and `sticky: 1` is
effectively "activate this turn only". Same arithmetic for `cooldown: N`: the entry is suppressed for
`N-1` turns after the cooldown starts.
Re-generating without a new message (`chat.length <= start`) deletes the effect instead of counting
down, unless `protected` (the sticky→cooldown handoff).

`cleanUp()` (788-792) empties the three buffers at the end of `checkWorldInfo`.

---

## 8. Inclusion groups (`filterByInclusionGroups`, 5388-5475 + helpers)

Called on `newEntries` (current pass only), before probability. `allActivatedEntries` is consulted so
groups already satisfied in an earlier pass are not re-rolled.

### 8.1 Grouping

```js
const grouped = newEntries.filter(x => x.group)
    .reduce((acc, item) => { item.group.split(/,\s*/).filter(x => x).forEach(g => (acc[g] ??= []).push(item)); return acc; }, {});
```

An entry may belong to several groups (`"a, b"`).

### 8.2 Step 1 — timed-effect filter (`filterGroupsByTimedEffects`, 5337-5378)

For each group:
* If any member `isEffectActive('sticky')` ⇒ remove all non-sticky members, set `hasSticky[key] = true`.
* Then remove any member on cooldown, then any member with `delay` (defensive; unreachable in practice).

### 8.3 Step 2 — group scoring (`filterGroupsByScoring`, 5292-5328)

* Skipped entirely when `!world_info_use_group_scoring && !group.some(x => x.useGroupScoring)`
  (i.e. per-group enable: global flag **or** any entry's flag).
* Skipped when the group has sticky members.
* `scores[i] = buffer.getScore(entry, scanState)`; `maxScore = Math.max(...scores)`; every member with
  `(entry.useGroupScoring ?? world_info_use_group_scoring)` truthy and `score < maxScore` is removed
  (ties survive).

`getScore` (428-473):

```js
bufferState = this.get(entry, scanState);          // recomputed; includes recursion buffer as per state
primaryScore   = count of entry.key         matches
secondaryScore = count of entry.keysecondary matches
if (!entry.key.length) return 0;                   // keyless entries always score 0
if (keysecondary.length > 0) {
    if (selectiveLogic === AND_ANY) return primaryScore + secondaryScore;
    if (selectiveLogic === AND_ALL) return secondaryScore === keysecondary.length ? primaryScore + secondaryScore : primaryScore;
}
return primaryScore;                                // NOT_ALL / NOT_ANY add nothing
```

### 8.4 Step 3 — winner selection (5421-5474), per group

1. `hasSticky[key]` ⇒ skip (sticky already won, others removed).
2. If any **already activated** entry (from a previous pass) has `x.group === key` **string-equal** ⇒
   `removeAllBut(group, null)` — i.e. drop every member of this group this pass.
   (Quirk: comparison uses the whole `group` string, so `"a, b"` does not match key `"a"`.)
3. `group.length <= 1` ⇒ skip.
4. `const prios = group.filter(x => x.groupOverride).sort((a,b) => b.order - a.order);` if any ⇒ winner
   is `prios[0]` (**highest `order`**). `groupWeight` is ignored in override mode.
5. Otherwise weighted random:
   ```js
   const totalWeight = group.reduce((acc, i) => acc + (i.groupWeight ?? 100), 0);
   const rollValue = Math.random() * totalWeight;
   let currentWeight = 0;
   for (const entry of group) { currentWeight += (entry.groupWeight ?? 100);
                                if (rollValue <= currentWeight) { winner = entry; break; } }
   ```
   Weights are **not** normalised; a single entry with weight 0 can never win (`rollValue > 0`).
6. `removeAllBut(group, winner)` — every other member is spliced out of `newEntries` (so an entry that
   is also a member of another group can be removed by this group's decision).

---

## 9. Token budget

* Budget in tokens: `Math.round(world_info_budget * maxContext / 100) || 1` (4736).
  `world_info_budget` is a **percentage** (default 25). `|| 1` guarantees a floor of 1.
* Optional absolute cap: if `world_info_budget_cap > 0 && budget > cap` then `budget = cap` (4738-4741).
* Accounting (5010, 5059-5061):
  `textToScanTokens = tokens(allActivatedText)` once per pass (this is the joined recursion text of
  previous passes, so ≈ the text of previously accepted entries), plus `tokens(newContent)` where
  `newContent` accumulates `content + "\n"` for **every entry processed in this pass so far, including
  the current one and including entries that were dropped**.
* The current entry is dropped when `textToScanTokens + tokens(newContent) >= budget` — note `>=`, and
  note the current entry's own text is already counted.
* **Drop order** = reverse of the processing order: sticky entries first, then the `sortedEntries`
  index (chat lore → persona lore → [character lore → global lore | interleaved | global → character]
  per strategy), each book internally by `order` descending. So the lowest-`order` global entries are
  dropped first.
* Once an entry overflows, `token_budget_overflowed = true` for the remainder of the scan:
  * subsequent non-`ignoreBudget` entries are skipped while any `ignoreBudget` entry is still pending
    later in `newEntries`, otherwise the loop `break`s;
  * recursion is not scheduled (5097, 5104) and min-activations does not advance (5111);
  * `world_info_overflow_alert` triggers one `toastr.warning`
    (`World info budget reached after N entries.`).
* `entry.ignoreBudget === true` bypasses the check entirely, but its text still counts towards
  `newContent` for the entries after it.
* There is **no per-book entry-count limit**; the only limits are the token budget and
  `world_info_max_recursion_steps`.

---

## 10. Insertion, ordering and output buckets (5189-5281)

```js
[...allActivatedEntries.values()].sort(sortFn)     // order DESCENDING
    .forEach(entry => {
        const regexDepth = entry.position === 4 ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const content = getRegexedString(entry.content, regex_placement.WORLD_INFO,
                                         { depth: regexDepth, isMarkdown: false, isPrompt: true });
        if (!content) return;                       // empty after macro/regex processing → dropped
        switch (entry.position) { ... }
    });
```

| `position` | Name | Bucket | Push style | Final form |
|---|---|---|---|---|
| 0 | before char defs | `WIBeforeEntries` | `unshift` | `worldInfoBefore = list.join('\n')` |
| 1 | after char defs | `WIAfterEntries` | `unshift` | `worldInfoAfter = list.join('\n')` |
| 5 | before example messages | `EMEntries` | `unshift({ position: wi_anchor_position.before, content })` | array of `{position, content}` |
| 6 | after example messages | `EMEntries` | `unshift({ position: wi_anchor_position.after, content })` | same |
| 2 | before Author's Note | `ANTopEntries` | `unshift` | `ANBeforeEntries` |
| 3 | after Author's Note | `ANBottomEntries` | `unshift` | `ANAfterEntries` |
| 4 | at depth | `WIDepthEntries` | grouped then `entries.unshift(content)` | `{ depth, role, entries: string[] }` |
| 7 | outlet | `WIOutletEntries[outletName]` | **`push`** | `{ [outletName]: string[] }` |

Because iteration is `order` **descending** and buckets use `unshift`, **every bucket except outlets
ends up ascending by `order`** (1, 2, 3 … 999) — i.e. low `order` appears first in the string.
Outlets use `push`, so their arrays are **descending** by order (a real inconsistency; replicate it or
document the deviation).

Depth grouping (5235-5247):

```js
const existing = WIDepthEntries.findIndex(e => e.depth === (entry.depth ?? DEFAULT_DEPTH)
                                            && e.role === (entry.role ?? extension_prompt_roles.SYSTEM));
if (existing !== -1) WIDepthEntries[existing].entries.unshift(content);
else WIDepthEntries.push({ depth: entry.depth, entries: [content], role: entry.role ?? extension_prompt_roles.SYSTEM });
```

Quirk: the lookup uses `entry.depth ?? 4`, but the stored `depth` is the raw `entry.depth`. If
`depth` is `undefined`/`null` the entry creates its own group with `depth: undefined` instead of
joining the `4` group.

`role` only matters for `position: 4`; defaults to `SYSTEM` (0). UI writes `null` for other positions,
which `??` maps back to `SYSTEM`.

Author's Note hijack (5268-5272), only when `shouldWIAddPrompt`:

```js
const originalAN = context.extensionPrompts[NOTE_MODULE_NAME].value;
const ANWithWI = `${ANTopEntries.join('\n')}\n${originalAN}\n${ANBottomEntries.join('\n')}`
                     .replace(/(^\n)|(\n$)/g, '');
context.setExtensionPrompt(NOTE_MODULE_NAME, ANWithWI, chat_metadata[metadata_keys.position],
                           chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan,
                           chat_metadata[metadata_keys.role]);
```

Return value (5281):

```js
{ worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries,
  ANBeforeEntries: ANTopEntries, ANAfterEntries: ANBottomEntries,
  outletEntries: WIOutletEntries, allActivatedEntries: new Set(allActivatedEntries.values()) }
```

`getWorldInfoPrompt` (892-915) additionally computes `worldInfoString = worldInfoBefore + worldInfoAfter`
(no separator), emits `WORLD_INFO_ACTIVATED` (non-dry-run), and maps the names for the caller.

---

## 11. Exact prompt string format

**There is no header, no separator, no `{{{` wrapper, no entry title.**

* `worldInfoBefore` = the bucket contents joined with a single `\n`.
* `worldInfoAfter`  = same.
* `worldInfoString` = `worldInfoBefore + worldInfoAfter` (raw concatenation; if both are non-empty they
  touch with **no** newline between them — the consumer normally uses before/after separately).
* No trailing newline is added.
* Depth groups: `entries.join('\n')`, injected as one extension prompt at `depth` with `role`.
* Outlets: `value.join('\n')`.
* AN: `ANTop\n…originalAN…\nANBottom` with one leading/trailing newline stripped.

Consumer side (so the re-implementation places the same text):

| Consumer | Placement |
|---|---|
| Text completion (`public/script.js:4711-4713`) | `{{wiBefore}}` / `{{wiAfter}}` macros in the story string; default template (`settings.json` → `context.story_string`) is `{{system}}\n{{wiBefore}}\n{{description}}\n…{{scenario}}\n{{wiAfter}}\n{{persona}}\n` |
| Chat completion (`openai.js:1212-1218`) | two separate `role: 'system'` messages with identifiers `worldInfoBefore` and `worldInfoAfter`, emitted as `worldInfoBefore, main, worldInfoAfter, charDescription, charPersonality, scenario, personaDescription` |
| WI format wrapper (`openai.js:789-801`) | both strings pass through `formatWorldInfo()` = `stringFormat(oai_settings.wi_format, value)`; default `wi_format` is `'{0}'` (no wrapper) |
| Depth entries (`script.js:4668-4673`) | `setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(depth, role), joined, extension_prompt_types.IN_CHAT, depth, false, role)` ⇒ one chat message at that depth with that role |
| Example-message entries (`script.js:4639-4655`) | appended/prepended to `mesExamplesArray`, then parsed as example blocks |
| Outlets (`script.js:4674-4678`) | `setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(name), joined, extension_prompt_types.NONE, 0)` — consumed by other extensions, never directly injected |
| Author's Note | merged into the AN extension prompt as above (only if AN is enabled and `shouldWIAddPrompt`) |

---

## 12. `checkWorldInfo` reference pseudocode (TypeScript-shaped)

```ts
async function checkWorldInfo(chat: string[], maxContext: number, dryRun: boolean, g: GlobalScanData) {
  const buffer = new WorldInfoBuffer(chat, g);                  // reversed core chat
  for (const k of Object.keys(extPrompts)) if (extPrompts[k]?.scan) buffer.addInject(await prompt(k));

  let state = INITIAL, count = 0, overflow = false;
  const activated = new Map<string, Entry>();                   // `${world}.${uid}`
  const failed = new Set<Entry>();
  let allText = '';
  let budget = Math.round(cfg.budget * maxContext / 100) || 1;
  if (cfg.budgetCap > 0 && budget > cfg.budgetCap) budget = cfg.budgetCap;

  const entries = await getSortedEntries();                     // §4.2
  const timed = new TimedEffects(chat, entries, dryRun);
  timed.check();                                               // §7.2

  const levels = [...new Set(entries.filter(e => e.delayUntilRecursion)
      .map(e => e.delayUntilRecursion === true ? 1 : e.delayUntilRecursion))].sort((a,b)=>a-b);
  let curLevel = levels.shift() ?? 0;

  while (state !== NONE) {
    if (cfg.maxRecursionSteps && cfg.maxRecursionSteps <= count) break;
    count++;
    let next = NONE;
    const now = new Set<Entry>();
    for (const e of entries) { /* gates 1..20 of §6.3 */ }
    let fresh = sortActivated(now, entries, timed);             // §6.4
    groupFilter(fresh, activated, buffer, state, timed);        // §8
    const baseTokens = await tokens(allText);
    let ignoresLeft = fresh.filter(e => e.ignoreBudget).length;
    let acc = '';
    for (const e of fresh) {
      ignoresLeft -= e.ignoreBudget ? 1 : 0;
      if (overflow && !e.ignoreBudget) { if (ignoresLeft > 0) continue; break; }
      if (!probabilityOk(e, timed, failed)) continue;
      e.content = substituteParams(e.content);
      acc += e.content + '\n';
      if (!e.ignoreBudget && baseTokens + await tokens(acc) >= budget) { overflow = true; continue; }
      activated.set(`${e.world}.${e.uid}`, e);
    }
    const ok = fresh.filter(e => !failed.has(e));
    const okRec = ok.filter(e => !e.preventRecursion);
    /* §6.6 scheduling */
  }
  /* §10 buckets */
}
```

---

## 13. Character-embedded `character_book`

A card may carry `data.character_book` (Character Card V2 spec). It is **not** used in place: it must
be imported into a world file first (`importEmbeddedWorldInfo`, 5731-5770, → `convertCharacterBook`).

```js
convertCharacterBook(characterBook) → { entries: { [id]: entry }, originalData: characterBook }
```

`characterBook.entries[]` (array) fields and their mapping (5617-5674):

| Card field | World Info field | Notes |
|---|---|---|
| `id` | `uid` + `entries` key | If `id` is `undefined`, the array index is used and written back onto the entry |
| `keys` | `key` | |
| `secondary_keys` | `keysecondary` | `?? []` |
| `comment` | `comment` | Also drives `addMemo: !!comment` |
| `content` | `content` | |
| `constant` | `constant` | `?? false` |
| `selective` | `selective` | `?? false` — note: **false by default here**, unlike the ST template's `true` |
| `insertion_order` | `order` | |
| `enabled` | `disable` | inverted: `disable: !entry.enabled` |
| `position: 'before_char' \| 'after_char'` | `position` | `'before_char' → 0`, anything else → `1` |
| `extensions.position` | `position` | Takes precedence over the spec `position` |
| `extensions.*` | see `originalWIDataKeyMap` | `exclude_recursion`, `prevent_recursion`, `delay_until_recursion`, `display_index`, `probability`, `useProbability`, `depth`, `selectiveLogic`, `outlet_name`, `group`, `group_override`, `group_weight`, `scan_depth`, `case_sensitive`, `match_whole_words`, `use_group_scoring`, `automation_id`, `role`, `vectorized`, `sticky`, `cooldown`, `delay`, `match_persona_description`, `match_character_description`, `match_character_personality`, `match_character_depth_prompt`, `match_scenario`, `match_creator_notes`, `triggers`, `ignore_budget` |

Differences vs. a standalone world file worth encoding in a re-implementation:

1. `uid` comes from the card's `id`, which may be **sparse or non-sequential**.
2. `originalData: characterBook` is stored on the book, and `originalWIDataKeyMap` (2687-2724) maps
   world-info field → card path so edits can be written back into the card's `character_book`.
3. `selective` defaults to `false` from a card (secondary keys then never matter), while a new ST entry
   defaults to `true`.
4. `characterFilter` and `triggers` are not part of the V2 spec; only `extensions.triggers` maps.
5. `name`/`extensions` on the resulting book object are not produced by the converter.

Other converters in the same file (for import support, all producing the same shape):
`convertAgnaiMemoryBook` (5477), `convertRisuLorebook` (5522), `convertNovelLorebook` (5567).

---

## 14. Small but load-bearing details

* Entry identity everywhere is `"${entry.world}.${entry.uid}"`; a book rename or uid change silently
  orphans `chat_metadata.timedWorldInfo` entries.
* `entry.hash` = `getStringHash(JSON.stringify(entry))` where `getStringHash` is a cyrb53-style hash
  (`utils.js:522-539`), computed **after** decorator stripping and **before** `world`/`hash` exist.
  Any field change ⇒ new hash ⇒ old timed effects are ignored and eventually garbage-collected.
* `allActivatedEntries` is a `Map`, so the last write wins if two books contain the same
  `world.uid` (impossible in practice unless a book is loaded twice).
* Prompt-time regex extension (`getRegexedString(..., regex_placement.WORLD_INFO, { depth, isMarkdown: false, isPrompt: true })`)
  runs **per entry**, with `depth` only set for `position: 4`. Empty results are dropped.
* `substituteParams` is applied twice to content: once at activation (5058) and again later by the
  prompt builder for the story string / `baseChatReplace` for EM entries.
* `WORLDINFO_SCAN_DONE` (5150-5186) is emitted after **every** pass with a mutable
  `{ state, new, activated, sortedEntries, recursionDelay, budget, timedEffects }`; listeners may
  rewrite `state.next`, `activated.text`, `recursionDelay.currentLevel`, `budget.current`,
  `budget.overflowed`.
* `WORLDINFO_FORCE_ACTIVATE` (1020-1029) fills the static
  `WorldInfoBuffer.externalActivations` map (`"${world}.${uid}" → entry`); it is consumed at gate 13 and
  reset at the end of every `checkWorldInfo` (5275). Entries missing `world` or `uid` are rejected.
* `getSortedEntries()` is called on every `checkWorldInfo`, so all four book lists are re-flattened per
  generation; book JSON itself is cached in `worldInfoCache` (`StructuredCloneMap`, 882).
* `getWorldInfoSettings()` / `updateWorldInfoSettings()` (795-853) round-trip exactly the 14 settings in
  §2; `world_info` (global selection) travels separately as `activeWorldInfo`.

---

## 15. Open questions

1. **"Sequential" formatting.** No `sequential` mode exists in 1.19.0 (grep across `public/` finds only
   the unrelated "sequential message numbers" chat setting). What the task calls "sequential" is
   presumably either (a) the `order`-ascending concatenation described in §10/§11, or (b) a
   third-party extension. If a specific behaviour is required, it must be specified separately.
2. **`sticky`/`cooldown` off-by-one.** The implementation makes `sticky: N` last `N-1` turns
   (`start = L`, `end = L+N`, active while `start < len < end`). Upstream documentation/UI text says
   "N messages". I documented the code, not the docs; confirm which is intended before writing tests.
3. **`delayUntilRecursion` level 1 with no recursion and no higher level** never activates (§6.6
   quirk). This looks unintentional but is the current behaviour. Confirm whether to replicate.
4. **Outlets are descending by `order`** while every other bucket is ascending (§10). Likely a bug.
5. **`WIDepthEntries.depth` may be `undefined`** when two entries share the implicit default depth but
   the grouping lookup uses `?? 4` (§10). Replicate or normalise deliberately.
6. **`entry.selective === false` with non-empty `keysecondary`** silently ignores the secondary keys
   (4924). Imported cards default `selective` to `false`, so this is common in the wild.
7. **Budget accounting is approximate and includes dropped entries** in `newContent`, and
   `allActivatedText` is the recursion text, not a faithful concatenation of accepted entries
   (entries activated in the *same* pass are counted via `newContent`, entries that were accepted but
   `preventRecursion` are counted in neither after their pass ends). Exact parity requires copying the
   algorithm verbatim rather than "correcting" it.
8. **Budget-dropped entries still enter the recursion buffer** (they are not in
   `failedProbabilityChecks`, so they count as `successfulNewEntriesForRecursion`). In practice
   `token_budget_overflowed` blocks recursion, so this is only reachable via a `WORLDINFO_SCAN_DONE`
   listener that clears the flag.
9. **`min_activations` + `max_recursion_steps`.** The comment at 4767 says "if
   world_info_max_recursion_steps is non-zero min activations are disabled, and vice versa", but the
   code only hard-breaks on `max_recursion_steps`; there is no reciprocal disabling. Treat the comment
   as stale.
10. **`vectorized`** has no engine behaviour in core; vector/lorebook-retrieval behaviour lives in
    extensions (Vectra etc.). Out of scope here.
11. **`role` for non-depth positions** is written as `null` by the editor and defaulted to `SYSTEM`;
    old files may hold `0/1/2` for positions 0-3 where the value is simply ignored.
12. **Legacy `position` values 5/6** meant something else in older ST releases (depth roles). 1.19.0
    has no migration, so old books relying on that are interpreted as EM anchors. This spec is
    authoritative only for 1.19.0.

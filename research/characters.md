# SillyTavern Character Cards — Re-Implementation Spec (TypeScript/JavaScript)

Derived by reading the SillyTavern checkout at `C:\Users\lenovo\Desktop\sillytavern-rewrite` (read-only reference).
Every literal string, key name and default below is quoted from that checkout. Anything that could **not** be
proven from the code is listed in **Open questions** instead of being guessed.

## Sources (files actually read)

| Purpose | File |
| --- | --- |
| PNG ↔ card JSON | `src/character-card-parser.js`, `src/png/encode.js` |
| CHARX (ZIP) importer | `src/charx.js`, `src/util.js` (`extractFileFromZipBuffer`, `extractFilesFromZipBuffer`, `normalizeZipEntryPath`, `mutateJsonString`, `getUniqueName`, `humanizedDateTime`) |
| Server-side card read/write, import/export, merge | `src/endpoints/characters.js` |
| Card validation | `src/validator/TavernCardValidator.js`, `src/types/spec-v2.d.ts` |
| Frontend card type docs | `public/scripts/char-data.js` |
| Frontend card fields + example parsing | `public/script.js` (`getCharacterCardFieldsLazy`, `getCharacterCardFields`, `parseMesExamples`, `formatMessageHistoryItem`) |
| Chat-completion prompt assembly | `public/scripts/openai.js`, `public/scripts/PromptManager.js` |
| Text-completion story string / instruct mode | `public/scripts/power-user.js`, `public/scripts/instruct-mode.js` |
| Chat files / persona / world info | `src/endpoints/chats.js`, `public/global.d.ts`, `public/scripts/personas.js`, `public/scripts/world-info.js` |
| Defaults | `src/constants.js`, `public/scripts/constants.js`, `default/content/default_Seraphina.png` |
| Disk layout | `src/constants.js` `USER_DIRECTORY_TEMPLATE`, `src/users.js` |

There is **no** `public/scripts/character-card-parser.js` and no `public/scripts/characters.js` in this checkout.
The frontend receives already-parsed cards from `/api/characters/*` and does not read PNG chunks itself.

---

# 0. Storage layout (context you need before the formats)

Per user (`DATA_ROOT/<handle>/`), from `USER_DIRECTORY_TEMPLATE` in `src/constants.js`:

```
characters/                 ← one PNG per character: "<internal name>.png"
chats/<internal name>/      ← one .jsonl per chat:  "<chat name>.jsonl"
group chats/                ← "<group id>.jsonl"
groups/                     ← group definitions
worlds/                     ← world info books ("<book name>.json")
user/images/<character>/    ← misc image assets (CharX leftovers)
thumbnails/{avatar,bg,persona}/
User Avatars/               ← persona avatars (avatar id is the file name)
```

Rules that matter:

* The card **file name is the character's unique id** (`avatar` field in API payloads, e.g. `Seraphina.png`).
  It is sanitized with the `sanitize-filename` package.
* New file name = `getPngName(name)` = `getUniqueName(sanitize(name), n => exists(characters/${n}.png), {startIndex:0, nameBuilder:(base,i)=> i===0 ? base : `${base}${i}`, maxTries:10000})`.
  So collisions become `Name1.png`, `Name2.png`, … (no separator, index appended).
* Chat folder = character file name **without** `.png` (`item.replace('.png','')`).
* Card images are normalized to `AVATAR_WIDTH = 512`, `AVATAR_HEIGHT = 768` (`image.cover({w,h})`), format PNG.
* `DEFAULT_AVATAR_PATH = './public/img/ai4.png'` (used when no avatar exists, for JSON/v1 imports, CharX without icon).
* Character names inside JSON are run through `sanitize-filename` on import/create.
* `humanizedDateTime()` produces `YYYY-MM-DD@HHhMMmSSsMSms` (e.g. `2023-05-12@21h32m29s228ms`); older cards contain
  the legacy humanized form `2023-5-12 @21h 32m 29s 228ms` in `create_date`.

---

# 1. Card specifications

Three shapes are accepted. The validator (`TavernCardValidator.validate()`) tries **V1 first**, then V2, then V3, and
returns the spec number (`1|2|3`) or `false`. A card that satisfies both V1 and V2 reports `1`.

## 1.1 Spec V1 (flat / "TavernAI classic")

Stored as a flat JSON object (no wrapper). Required fields (existence only, any type):

```jsonc
{
  "name":          "string",
  "description":   "string",
  "personality":   "string",
  "scenario":      "string",
  "first_mes":     "string",
  "mes_example":   "string"
}
```

SillyTavern additionally reads/writes these non-spec, flat fields (all optional; see `convertToV2` / `importFromPng`):

| Field | Type | Meaning / default |
| --- | --- | --- |
| `creatorcomment` | string | legacy creator notes. Default `''` |
| `creator_notes` | string | newer alias, read as `creatorcomment ?? creator_notes`. Default `''` |
| `avatar` | string | always written as the literal `"none"`; the real avatar is the PNG file name. When the server serves a card it overwrites this with the file name (`jsonObject.avatar = item`) |
| `chat` | string | currently selected chat file name *without* `.jsonl`. Default `${name} - ${humanizedDateTime()}` |
| `talkativeness` | number \| string | default `0.5` (some cards store `"0.5"` as a string, e.g. `default_Seraphina.png`) |
| `fav` | boolean | default `false` |
| `tags` | string[] \| string | default `[]`; a string is split on `,`, trimmed, empties dropped |
| `create_date` | string | ISO string or legacy humanized date; if missing on read it is `new Date(ctime).toISOString()` |
| `data` | object | V2 payload smuggled into a V1 card (see 1.4 hoisting) |
| `json_data` | string | raw JSON of the card, added by the server only in API responses (never persisted; it is stripped on save) |

Legacy third-party V1 noise (`char_name`, `char_persona`, `char_greeting`, `world_scenario`, `example_dialogue`, …)
is only accepted by the separate "gradio JSON" / Pygmalion-notepad import path, which maps:

```
name        := char_name
description := char_persona     ?? ''
first_mes   := char_greeting    ?? ''
mes_example := example_dialogue ?? ''
scenario    := world_scenario   ?? ''
```

## 1.2 Spec V2 (the common format)

```jsonc
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": { /* see table */ }
}
```

Validation (`#validateDataV2`) requires `spec === 'chara_card_v2'`, `spec_version === '2.0'`, a truthy `data` object,
and **all** of these keys present on `data`:

`name, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt,
post_history_instructions, alternate_greetings, tags, creator, character_version, extensions`

plus `Array.isArray(data.alternate_greetings)`, `Array.isArray(data.tags)`, `typeof data.extensions === 'object'`.
Optional `data.character_book`, if present, must contain `extensions` (object) and `entries` (array).
Unknown extra keys are allowed and preserved.

### Every `data` field

| Field | Type | Required by validator | Default written by SillyTavern (`charaFormatData`) | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | ✔ | `request.body.ch_name` (already sanitized) | character display name |
| `description` | string | ✔ | `data.description \|\| ''` | main prompt block |
| `personality` | string | ✔ | `|| ''` | |
| `scenario` | string | ✔ | `|| ''` | |
| `first_mes` | string | ✔ | `|| ''` | opening message; also displayed/edited as "first message" |
| `mes_example` | string | ✔ | `|| ''` | raw `<START>`-delimited examples |
| `creator_notes` | string | ✔ | `|| ''` | UI only, never sent to the model |
| `system_prompt` | string | ✔ | `|| ''` | overrides the "Main Prompt" when non-empty and `power_user.prefer_character_prompt` (default `true`) |
| `post_history_instructions` | string | ✔ | `|| ''` | overrides "Post-History Instructions" (`jailbreak`) when non-empty and `power_user.prefer_character_jailbreak` (default `true`) |
| `tags` | string[] | ✔ | string → `split(',').map(trim).filter(Boolean)`, else array, else `[]` | |
| `creator` | string | ✔ | `|| ''` | |
| `character_version` | string | ✔ | `|| ''` | |
| `alternate_greetings` | string[] | ✔ | `getAlternateGreetings()`: `Array.isArray` → as-is; `typeof === 'string'` → `[value]`; else `[]` | greetings 2..N |
| `extensions` | object | ✔ | `{}` plus the ST keys below | |
| `character_book` | object | ✘ | only when `data.world` resolves to a world file (see 4.12) | embedded lorebook |
| `group_only_greetings` | string[] | ✘ | not written by ST, but present (`[]`) in `default_Seraphina.png` | v3-era field; not read anywhere in this checkout |
| `assets` | object[] | ✘ | not written by ST; only read by the CharX importer | see §3 |
| `nickname` | string | ✘ | — | not present/used in this checkout |

### `data.extensions` — keys SillyTavern itself writes

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `talkativeness` | number | `0.5` (written as `data.talkativeness \|\| 0.5`, so a stored `0` becomes `0.5`) | group-chat chattiness (0..1) |
| `fav` | boolean | `false` (`data.fav == 'true'`, loose compare with the form string) | favourite flag |
| `world` | string | `''` | name of the linked world-info book in `worlds/` |
| `depth_prompt` | object | always written: `{prompt:'', depth:4, role:'system'}` | character-specific Author's Note |
| `depth_prompt.prompt` | string | `data.depth_prompt_prompt ?? ''` | text injected at depth |
| `depth_prompt.depth` | number | `4` (`depth_prompt_depth_default`); non-numeric input falls back to `4` | messages from the end of chat |
| `depth_prompt.role` | `'system' \| 'user' \| 'assistant'` | `'system'` (`depth_prompt_role_default`) | injection role |
| `regex_scripts` | object[] | — | character-scoped regex scripts, applied by the Regex extension; shape below |
| `risuai` | `{source: string[]}` + optional `additionalAssets` / `emotions` | — | RisuAI metadata; base64 sprites are extracted to the sprites folder and then deleted from the card (`src/endpoints/sprites.js`) |
| `pygmalion_id` | string | — | external id |
| `github_repo` | string | — | external link |
| `source_url` | string | — | external link |
| `chub` | `{full_path: string}` | — | Chub id |
| `perchance_data` | `{slug: ...}` | — | external id |
| `sd_character_prompt` | `{positive: string, negative: string}` | — | Stable Diffusion extension |
| `display_index`, `fav`, … | — | — | anything else is round-tripped untouched |

`RegexScriptData` fields (`public/scripts/char-data.js`):

```ts
{ id: string; scriptName: string; findRegex: string; replaceString: string; trimStrings: string[];
  placement: number[]; disabled: boolean; markdownOnly: boolean; promptOnly: boolean; runOnEdit: boolean;
  substituteRegex: number; minDepth: number; maxDepth: number; }
```

Scripts are applied when `characters[this_chid].data.extensions.regex_scripts` is a non-empty array
(`public/scripts/extensions/regex/engine.js`), i.e. they are per-character, not global.

### `data.character_book` (embedded world info)

Optional. Shape (from `src/types/spec-v2.d.ts`):

```ts
type CharacterBook = {
  name?: string; description?: string; scan_depth?: number; token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, any>;   // required
  entries: CharacterBookEntry[];     // required
};
type CharacterBookEntry = {
  keys: string[];
  content: string;
  extensions: Record<string, any>;   // required
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  position?: 'before_char' | 'after_char';
};
```

ST only requires `entries` (array) and `extensions` (object) on the book, and only on V2 cards.
Runtime activation uses the **world-info entry format** (§4.12), not this object directly.

## 1.3 Spec V3

```jsonc
{ "spec": "chara_card_v3", "spec_version": "3.0", "data": { /* anything */ } }
```

What this checkout actually enforces (`TavernCardValidator`):

* `spec` must be exactly `'chara_card_v3'`.
* `spec_version` is coerced with `Number(...)` and must satisfy `>= 3.0 && < 4.0`
  (`'3.0'`, `'3.5'`, `3.1` all pass; `'2.9'` and `'4.0'` fail).
* `data` must be a non-null object. **No field inside `data` is required or validated.**
* Nothing in the codebase reads v3-only fields. `default/content/default_Seraphina.png` contains both a `chara`
  (v2) and a `ccv3` chunk whose JSON is byte-identical except `spec`/`spec_version`; its `data` still contains all
  the v1/v2 keys plus `group_only_greetings: []`.

ST's PNG writer **always** synthesizes a v3 chunk from whatever V2 JSON it is given (see §2.3), so a V3 card in
practice is a V2 card with the two `spec` fields rewritten.

## 1.4 Reading and hoisting (`getCharaCardV2` / `readFromV2`)

`getCharaCardV2(json, dirs, hoistDate = true)`:

* If `json.spec === undefined` → treat as V1: build a V2 card with `convertToV2()`; if `hoistDate` and no
  `create_date`, set `create_date = new Date().toISOString()`.
* Else → `readFromV2(json)`.

`readFromV2(char)` copies V2 values up to the legacy flat fields and deletes `json_data`:

| Flat field | V2 path | Fallback if missing |
| --- | --- | --- |
| `name` | `data.name` | none (warn) |
| `description` | `data.description` | none |
| `personality` | `data.personality` | none |
| `scenario` | `data.scenario` | none |
| `first_mes` | `data.first_mes` | none |
| `mes_example` | `data.mes_example` | none |
| `talkativeness` | `data.extensions.talkativeness` | `0.5` |
| `fav` | `data.extensions.fav` | `false` |
| `tags` | `data.tags` | none |

Also `char.chat ??= `${char.name} - ${humanizedDateTime()}``.
Consequence: the in-memory `character` object has **both** flat and `data.*` fields; the UI mostly reads the flat ones
(`character.description`), the prompt code reads flat ones, and exports serialize both.

Create/update path (`charaFormatData`) preserves foreign keys: it starts from `tryParse(data.json_data) || {}`, deletes
`json_data`, then overwrites the known fields — unknown top-level keys survive.

`unsetPrivateFields(char)` (called before every export/import): sets `fav = false`, `data.extensions.fav = false`,
`_.unset(char, 'chat')`. So exported cards never carry a chat pointer or favourite state.

---

# 2. PNG embedding (tEXt chunks)

Reference: `src/character-card-parser.js` + `src/png/encode.js`, reading via `png-chunks-extract` and `png-chunk-text`.

## 2.1 PNG file / chunk byte layout

```
offset 0:  8-byte signature: 89 50 4E 47 0D 0A 1A 0A
then, repeated until IEND:
   uint32be  length        // number of bytes of `data` only (excludes type and crc)
   byte[4]   type          // ASCII: "IHDR", "IDAT", "tEXt", "IEND", ...
   byte[n]   data
   uint32be  crc           // CRC-32 of (type || data), i.e. the 4 type bytes followed by data
```

* CRC-32 is the standard PNG/zlib CRC (poly `0xEDB88320`, init `0xFFFFFFFF`, final xor `0xFFFFFFFF`,
  computed over type+data, **not** over the length field).
  `src/png/encode.js` implements it as `crc32(data, crc32(new Uint8Array(nameChars)))` using the `crc` package.
* Length and CRC are **big-endian** (the encoder uses a typed-array trick that writes the little-endian host value
  byte-reversed, which is big-endian on the wire).
* `IEND` has length 0 and a fixed CRC.
* `png-chunks-extract` (used for reading) skips the 8-byte signature, parses chunks, stops at `IEND`, and returns
  `{name, data}` objects. Any bytes after `IEND` are dropped.
* All chunks are re-emitted by `src/png/encode.js` in their original order, with the same `data` bytes; only the
  length/type/CRC framing is rebuilt. IDAT payload bytes therefore stay identical.

## 2.2 `tEXt` chunk payload

```
keyword (Latin-1, 1..79 bytes, no NUL)  ||  0x00  ||  text (Latin-1, may be empty, no NUL)
```

The keyword is case-insensitive for ST's purposes: both read and write compare
`keyword.toLowerCase() === 'chara'` / `'ccv3'`.

The card text is **standard base64 (with padding, no line breaks) of the UTF-8 bytes of the minified JSON**:

```ts
const text = Buffer.from(jsonString, 'utf8').toString('base64');   // writer
const jsonString = Buffer.from(chunkText, 'base64').toString('utf8'); // reader
```

Because base64 is ASCII, the Latin-1 `tEXt` restriction is never a problem.

Keywords used:

| keyword | content |
| --- | --- |
| `chara` | base64(UTF-8 JSON) of the V2 card (`spec: "chara_card_v2"`, `spec_version: "2.0"`) |
| `ccv3` | base64(UTF-8 JSON) of a V3 rendering of the same card (`spec: "chara_card_v3"`, `spec_version: "3.0"`) |

Real example (`default/content/default_Seraphina.png`, verified by parsing the file):

```
IHDR(13) → IDAT(511505) → tEXt "chara"(20158 incl. keyword+NUL) → tEXt "ccv3"(20157) → IEND(0)
```

i.e. the text chunks are appended **after** IDAT and immediately before IEND (that is what ST's writer produces), and
both chunks carry the same 15,113-byte JSON apart from `spec`/`spec_version`.

## 2.3 Write algorithm (`write(image, data)`)

Input: `image` = PNG bytes (`Buffer`), `data` = card JSON **string**.

1. `chunks = extract(image)` (array of `{name, data}`, IEND last).
2. For every chunk named `tEXt`:
   * `decoded = PNGtext.decode(chunk.data)` → `{keyword, text}`;
   * if `decoded.keyword.toLowerCase()` is `'chara'` **or** `'ccv3'`, remove that chunk from the array.
   * Other `tEXt` chunks (e.g. third-party metadata, `Software`) are **preserved**.
3. `charaText = base64(UTF-8 bytes of data)`; `chunks.splice(-1, 0, PNGtext.encode('chara', charaText))`
   → inserted at index `length-1`, i.e. immediately before `IEND`.
4. Try to also add V3 (errors silently ignored, leaving only `chara`):
   ```ts
   const v3 = JSON.parse(data);
   v3.spec = 'chara_card_v3';
   v3.spec_version = '3.0';
   const ccv3Text = Buffer.from(JSON.stringify(v3), 'utf8').toString('base64');
   chunks.splice(-1, 0, PNGtext.encode('ccv3', ccv3Text));
   ```
   Note this **mutates only the two spec fields**; every other key (including legacy flat V1 fields) is kept and
   key order is preserved (`JSON.parse`/`JSON.stringify` round-trip).
   Because this insert happens after step 3, `ccv3` ends up **after** `chara`.
5. `return Buffer.from(encode(chunks))` — writes signature, then each chunk as
   `uint32be(len) || type4 || data || uint32be(crc32(type||data))`.

Resulting order: `… IDAT, tEXt(chara), tEXt(ccv3), IEND`.

## 2.4 Read algorithm (`read(image)`)

1. `chunks = extract(image)`.
2. `texts = chunks.filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data))`.
3. If `texts.length === 0` → `console.error('PNG metadata does not contain any text chunks.')` and
   `throw new Error('No PNG metadata.')`.
4. Find the first chunk whose lower-cased keyword is `'ccv3'`; if found, return `base64decode(text).toString('utf8')`.
5. Else find the first whose keyword is `'chara'`; if found, return the same decoding.
6. Else log `'PNG metadata does not contain any character data.'` and `throw new Error('No PNG metadata.')`.

**V3 (`ccv3`) takes precedence over V2 (`chara`).** CRCs are not verified when reading.

`parse(cardUrl, format = 'png')` is the file-level wrapper: only `'png'` is implemented
(`fs.readFileSync` + `read`), anything else throws `new Error('Unsupported format')`.

## 2.5 Updating an existing card without touching the image

Two levels of "keeping the image intact" exist in ST:

**(a) ST's own export path** (`POST /api/characters/export`, `format: 'png'`):

```js
const rawBuffer = await fs.readFile(filename);          // original PNG
const rawData   = read(rawBuffer);                       // existing JSON string
const mutated   = mutateJsonString(rawData, unsetPrivateFields);
const out       = write(rawBuffer, mutated);             // chunk rewrite only
```

The pixel data (IDAT bytes) is preserved byte-for-byte; only chunk framing and the two tEXt chunks change.

**(b) ST's own edit path** (`POST /api/characters/edit`, `/edit-avatar`, `/create`): the image goes through Jimp
(`applyAvatarCropResize`: optional crop, then `cover({w,h})` to 512×768 by default), is re-encoded as PNG by Jimp,
and *then* `write()` adds the metadata. Pixel content is preserved only if no crop/resize was requested; the bytes
are re-encoded. The write is atomic (`write-file-atomic`), target `characters/<file>.png`.

**Minimal implementation you should build** (equivalent result, no Jimp when nothing changes):

```
updateCardMetadata(png: Uint8Array, cardJson: string): Uint8Array
1. Walk chunks: signature, then (len,type,data,crc) until IEND. Keep every chunk's raw bytes.
2. Drop chunks with type == 'tEXt' whose keyword (bytes before first 0x00) ci-equals 'chara' or 'ccv3'.
3. Build two new chunks:
     payload = utf8('chara') || 0x00 || ascii(base64(utf8(cardJson)))
     chunk   = uint32be(payload.length) || 'tEXt' || payload || uint32be(crc32('tEXt'||payload))
   and the same with 'ccv3' using a JSON clone whose spec/spec_version are chara_card_v3/3.0.
4. Emit: signature || (all kept chunks in original order, IEND last but already removed) || chara || ccv3 || IEND.
   Every kept chunk may be copied verbatim (its CRC is still valid) — do not recompute CRCs of untouched chunks.
5. Optionally verify: read() round-trip returns exactly cardJson (ccv3 returns the mutated clone).
```

Strip-only: steps 1, 2, then emit the remaining chunks with the original `IEND`.
Insert-only (no existing metadata): steps 3–4 without removal.
Both `chara` and `ccv3` must be written together to avoid a V2/V3 mismatch (that is exactly why the writer removes
both and re-adds both; if `JSON.parse(data)` fails, only `chara` is written).

Caveats to encode in your implementation:

* A text chunk must not contain a NUL inside `text`; base64 guarantees this.
* Do not put the chunks between `IHDR` and `IDAT` unless you also accept that some third-party readers only look there;
  ST writes them after `IDAT`. Reading must not assume a position.
* If the input is an APNG, chunk copying still works (IDAT/fdAT untouched); ST additionally falls back to raw bytes
  when Jimp rejects an APNG.
* Very large cards are fine, but keep the 4-byte length field within 2^31-1.

## 2.6 Where the written JSON comes from

```ts
// create/update: form fields → charaFormatData(...) → JSON.stringify(char)
// rename:       read card → data.name = newName; name = newName → stringify
// merge:        read card → deepMerge(card, body) (sentinel "__@@UNSET@@" deletes keys) → validate → stringify
// edit-attr:    card[field] = value; card.data[field] = value → stringify   (field === 'json_data' rejected)
// import png:   read → (v2: unsetPrivateFields + readFromV2 + create_date=now | v1: convertToV2) → stringify
```

---

# 3. CHARX (`*.charx`) — ZIP container with assets

Importer only; **there is no CHARX export** in this checkout.

## 3.1 Archive structure

* It is a plain ZIP (deflate or store).
* Self-extracting/SFX archives are supported: the parser locates the first occurrence of `PK\x03\x04`
  (`50 4B 03 04`) and slices the buffer there.
* `card.json` is extracted with `extractFileFromZipBuffer(buffer, 'card.json')`, which matches the **first** entry
  whose `fileName.endsWith('card.json')` and whose path does not start with `__MACOSX`. So `card.json` may sit at the
  archive root or in a subfolder, but a nested path is resolved by suffix only.
* Missing card → `throw new Error('Failed to extract card.json from CharX file')`.
* `JSON.parse(card)`; if `card.spec === undefined` → `throw new Error('Invalid CharX card file: missing spec field')`.
  (In practice the file is a `chara_card_v3` document, but only the presence of `spec` is enforced.)
* All other entries are referenced by `card.data.assets[]`; they are extracted lazily by normalized path.

## 3.2 `data.assets[]`

```jsonc
"assets": [
  { "type": "icon",        "name": "main",     "ext": "png", "uri": "embeded://assets/icon/main.png" },
  { "type": "emotion",     "name": "joy",      "ext": "png", "uri": "embeded://assets/emotion/joy.png" },
  { "type": "expression",  "name": "smile",    "ext": "png", "uri": "embeded://assets/expression/smile.png" },
  { "type": "background",  "name": "forest",   "ext": "jpg", "uri": "embeded://assets/background/forest.jpg" },
  { "type": "user_icon",   "name": "user",     "ext": "png", "uri": "embedded://assets/icon/user.png" }
]
```

Recognized URI prefixes (compared case-insensitively against the lower-cased, trimmed uri):

```
'embeded://'   ← intentional misspelling, RisuAI exports
'embedded://'
'__asset:'
```

The remainder is normalized as a ZIP entry path: `\` → `/`, trim, strip leading `./`, `path.posix.normalize`,
strip one leading `/`, reject empty/`.`/anything starting with `..` (returns `null` → asset skipped).

* `ext` = `asset.ext` lower-cased with a leading dot stripped; if empty, fall back to the path extension.
* Recognized image extensions: `png, jpg, jpeg, webp, gif, apng, avif, bmp, jfif`.
* `type` is lower-cased.

## 3.3 Avatar selection

Among assets with `type === 'icon'`, an image extension and a resolved zip path:
prefer `name.toLowerCase() === 'main'`, else the first one. That file becomes the character PNG (then the card JSON is
written into it via §2.3). If there is no icon asset, `DEFAULT_AVATAR_PATH` is used.

## 3.4 Asset persistence (`persistCharXAssets`)

| Asset `type` | Target directory | File name |
| --- | --- | --- |
| `emotion`, `expression` | `characters/<character name>/` (sprites folder) | `<baseName>.<ext>`, `baseName` normalized with `-` separators |
| `background` | `characters/<character name>/backgrounds/` | `<baseName>.<ext>`, `_` separators |
| any other image type (not `icon`, not `user_icon`) | `user/images/<character name>/` | `<baseName>.<ext>` |
| `icon`, `user_icon` | not persisted (icon becomes the avatar) | — |

* `<character name>` = `processedCard.name` (the character name, **not** the unique PNG file name).
* `baseName` = lower-cased name with runs of non `[a-z0-9]` replaced by the separator, edges trimmed, then
  `sanitize-filename`; on empty result fall back to `<storageCategory>-<asset index>`.
  A trailing known image extension is stripped first (`"image.png"` + `ext:"png"` → `"image"`, avoiding `.png.png`).
* Sprites overwrite any file with the same base name (any extension); backgrounds likewise; misc overwrites the exact
  file name. Writes are atomic.
* `ext` default when missing: `png`.
* The character's expressions extension later reads `characters/<character name>/<label>.png`
  (e.g. `default/content/Seraphina/` contains `admiration.png`, `amusement.png`, … `surprise.png` — 28 emotion sprites,
  the default "Seraphina" sprite set).

## 3.5 Import pipeline (`importFromCharX`)

1. Read file, `getArrayBufferSlice` (exact-size ArrayBuffer).
2. `new CharXParser(data).parse()` → `{card, avatar, auxiliaryAssets, extractedBuffers}`.
3. `card.data.name = sanitize(card.data.name)`; `card.name = sanitize(card.data?.name || card.name)`.
4. `processedCard = readFromV2(card)`; `unsetPrivateFields(processedCard)`; `processedCard.create_date = new Date().toISOString()`.
5. `fileName = preservedFileName || getPngName(processedCard.name, dirs)`.
6. Persist auxiliary assets under `processedCard.name`.
7. `writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request)` → `characters/<fileName>.png`.

---

# 4. Mapping card fields into the LLM prompt

Two completely different pipelines exist. Both start from `getCharacterCardFields()`
(`public/script.js`), which resolves each field through `baseChatReplace(value, name1, name2)`:

```ts
baseChatReplace(v) = substituteParams(v)            // {{char}}, {{user}}, {{original}}, {{date}}, … macros
                     → collapseNewlines(v)           // only if power_user.collapse_newlines, default false
                     → v.replace(/\r/g, '')          // all CRs removed
```

`name1` = user/persona display name, `name2` = character name.

## 4.1 Field resolution table

| `CharacterCardFields` key | Source | Condition |
| --- | --- | --- |
| `description` | `character.description.trim()` (hoisted from `data.description`) | group cards may override with combined group description |
| `personality` | `character.personality.trim()` | group override possible |
| `scenario` | `chat_metadata.scenario \|\| character.scenario`, trimmed | group override possible |
| `mesExamples` | `chat_metadata.mes_example \|\| character.mes_example`, trimmed | group override possible |
| `system` | `chat_metadata.system_prompt \|\| character.data.system_prompt`, trimmed | `''` unless `power_user.prefer_character_prompt` (default **true**) |
| `jailbreak` | `character.data.post_history_instructions.trim()` | `''` unless `power_user.prefer_character_jailbreak` (default **true**) |
| `version` | `character.data.character_version ?? ''` | not prompted |
| `charDepthPrompt` | `character.data.extensions.depth_prompt.prompt.trim()` | injected at depth (§4.8) |
| `creatorNotes` | `character.data.creator_notes.trim()` | not prompted; only used for world-info scanning and UI |
| `firstMessage` | `character.first_mes.trim()` | inserted as the first chat message when a chat is created |
| `alternateGreetings` | `character.data.alternate_greetings.map(g => g.trim())` | offered as extra greeting choices, not prompted |
| `persona` | `power_user.persona_description.trim()` | user persona text |

`tags`, `creator`, `character_version`, `avatar` never reach the model. `avatar` is only the id/filename
(`/characters/<avatar>`), served separately.

## 4.2 Chat-completion pipeline (OpenAI/Claude/etc.)

`preparePromptsForChatCompletion()` builds a prompt collection; a `PromptManager` order decides positions.
Default order (`promptManagerDefaultPromptOrder`):

| # | identifier | kind |
| --- | --- | --- |
| 1 | `main` | system content, default `Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.` |
| 2 | `worldInfoBefore` | marker; content = activated WI with position "before" |
| 3 | `personaDescription` | system; content = persona text if `persona_description_position === IN_PROMPT` (0) |
| 4 | `charDescription` | marker; content = `description` |
| 5 | `charPersonality` | marker; content = `personality` |
| 6 | `scenario` | marker; content = `scenario` |
| 7 | `enhanceDefinitions` | **disabled** by default; content `If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.` |
| 8 | `nsfw` | "Auxiliary Prompt", default `''`, role system |
| 9 | `worldInfoAfter` | marker; content = activated WI with position "after" |
| 10 | `dialogueExamples` | marker; filled from `mes_example` (§5) |
| 11 | `chatHistory` | marker; the actual messages |
| 12 | `jailbreak` | "Post-History Instructions", default `''`; replaced by `data.post_history_instructions` when allowed |

Roles: `main / charDescription / charPersonality / scenario / worldInfo* / dialogueExamples / jailbreak / chatHistory(new-chat marker)` are `system`;
`chatHistory` real messages are `user`/`assistant`.

Field formatting:

```ts
scenarioText      = scenario && oai_settings.scenario_format ? substituteParams(oai_settings.scenario_format) : (scenario || '');
charPersonalityText = personality && oai_settings.personality_format ? substituteParams(oai_settings.personality_format) : (personality || '');
// defaults: scenario_format = '{{scenario}}', personality_format = '{{personality}}'
```

`description` is used verbatim (already macro-expanded). Each block is its own `system` message with content, and
before being sent, **consecutive `system` messages without a `name` are concatenated with `'\n'`**
(`ChatCompletion.squashSystemMessages`), except identifiers `newMainChat`, `newChat`, `groupNudge`.

Overrides: if `system` is non-empty it **replaces** the `main` prompt content (unless that prompt has
`forbid_overrides: true` or is disabled for the character). If `jailbreak` is non-empty it replaces the
`jailbreak` prompt content the same way.

Chat history messages: `content = mes` with all `\r` removed; `role = is_user ? 'user' : 'assistant'`, except
`extra.type === 'narrator'` → `system`. Depending on `names_behavior`
(`NONE|DEFAULT|CONTENT|COMPLETION`, default `DEFAULT`), `content` may be prefixed `` `${name}: ` ``:
`DEFAULT` prefixes name when in a group or when `force_avatar` is set (and not narrator); `CONTENT` prefixes always
(except narrator). A synthetic system message with `new_chat_prompt` (default `'[Start a new Chat]'`, group:
`'[Start a new group chat. Group members: {{group}}]'`) is placed at the very beginning of `chatHistory`.
On `continue`, `continue_nudge_prompt` default is `'[Continue your last message without repeating its original content.]'`.

## 4.3 Text-completion pipeline (KoboldAI, TextGen, NovelAI, …)

The card is rendered through a **Handlebars** template, `power_user.context.story_string`, default (exact):

```
{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}
```

(`{{#if ...}}` blocks, `\n` literal newlines.) Render params:

```ts
{
  description, personality,
  persona: power_user.persona_description_position === IN_PROMPT ? persona : '',
  scenario, system,
  char: name2, user: name1,
  wiBefore: worldInfoBefore, wiAfter: worldInfoAfter,
  loreBefore: worldInfoBefore, loreAfter: worldInfoAfter,     // legacy aliases
  anchorBefore, anchorAfter,                                   // extension prompt injections
  mesExamples: mesExamplesArray.join(''),
  mesExamplesRaw: mesExamplesRawArray.join(''),
}
```

Rendering rules (`renderStoryString`): compile with `{ noEscape: true }`, run `substituteParams` on the result, strip
leading `\n`s, append a trailing `\n` if the result is non-empty and lacks one (unless the story string is injected
in-chat). Final completion prompt concatenation (`combine()`):

```
combinedPrompt = combinedStoryString + mesExmString + mesSendString + generatedPromptCache
```

with `mesSendString = addChatsPreamble(addChatsSeparator(joinedChatMessages))`,
`addChatsSeparator(s) = substituteParams(power_user.context.chat_start + '\n') + s`, `chat_start` default `'***'`
→ history is preceded by `***\n`. `mesExmString` is the example block string (§5.3). For novelai a preamble is
prepended. Defaults: `power_user.sysprompt.enabled = true`, content
`Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.`, `post_history = ''`.

## 4.4 `alternate_greetings`

Not sent to the model. The UI builds the greeting chooser from
`[character.first_mes, ...character.data.alternate_greetings].filter(x => x)` and writes the selected text as the first
chat message (a normal assistant `chat` entry). `data.group_only_greetings` is **not read** by this checkout.

## 4.5 `creator_notes`, `tags`, `character_version`, `avatar`

* `creator_notes` — displayed in the UI; also supplied to world-info scanning as `creatorNotes` global scan data
  (only if a WI entry has `match_creator_notes`). Never inserted into the prompt by default.
* `tags` — UI only (list, filters, tag import). Not prompted.
* `character_version` — UI only (`{{char_version}}`/`version` is available to macros through `charVersion`/`version`).
* `avatar` — the PNG file name; used for `/characters/<avatar>`, thumbnails and grouping; not prompted.

## 4.6 `system_prompt` (Main Prompt override)

As in 4.2: the character's `data.system_prompt` replaces the global `main` prompt content verbatim when non-empty and
`prefer_character_prompt` is on. For text completion the same value is used as the `{{system}}` story-string param
(when `prefer_character_prompt`, otherwise `power_user.sysprompt.content`), and it is placed wherever the template puts
`{{system}}`.

## 4.7 `post_history_instructions` (jailbreak / PHI)

Chat completion: replaces the `jailbreak` prompt (default position: after chat history, i.e. last). Text completion:
appended after the chat history as a user-role line (`coreChat.push({mes: jailbreak, is_user: true})`) or spliced
before the continued message on `continue`. Disabled entirely when `prefer_character_jailbreak` is false.

## 4.8 `extensions.depth_prompt`

```ts
setExtensionPrompt(
  'DEPTH_PROMPT',
  charDepthPrompt || '',                 // baseChatReplace(prompt.trim())
  extension_prompt_types.IN_CHAT,        // 1
  characters[this_chid].data.extensions.depth_prompt.depth ?? 4,
  extension_settings.note.allowWIScan,   // whether WI scans this text
  getExtensionPromptRoleByName(character.data.extensions.depth_prompt.role ?? 'system'),
);
```

* `depth` = message index counted from the end of the chat (`0` = immediately after the last message, `4` = four
  messages up). In chat-completion it is inserted while iterating `injection_depth === i` for `i = 0..maxDepth`.
* `role` mapping: `'system' → 0`, `'user' → 1`, `'assistant' → 2` (`extension_prompt_roles`); an unknown name maps
  to `system` in practice (switch falls through).
* Adjacent in-chat injections with the same depth and role are joined with `'\n'`.
* In group chats, several characters' depth prompts are injected at their own depth (`DEPTH_PROMPT_<index>`).

## 4.9 `extensions.regex_scripts`

Applied to chat text before it is sent (`getRegexedString(message, placement, {isPrompt: true, depth})`) and to
displayed text. Placement flags decide user input/AI output/etc.; `promptOnly`/`markdownOnly` restrict the target;
`minDepth`/`maxDepth` limit by message depth. They do **not** rewrite card fields.

## 4.10 Persona (user side)

`power_user.personas[avatarId] = "Name"`, `power_user.persona_descriptions[avatarId] = {description, position, depth, role, lorebook, title}`.
Defaults: `position: 0` (`IN_PROMPT`), `depth: 2`, `role: 0` (`system`), `lorebook: ''`, `title: ''`.
Positions enum: `IN_PROMPT:0, AFTER_CHAR:1 (deprecated alias of 0), TOP_AN:2, BOTTOM_AN:3, AT_DEPTH:4, NONE:9`.
`persona_description` is the active description; it is the `persona` field and the `{{user}}` name is
`power_user.personas[user_avatar]`.

## 4.11 `character_book` at prompt time

The embedded book is **not scanned directly**. Two paths exist:

1. If `data.extensions.world` names an existing world file, that world is used for activation; on save
   `charaFormatData` copies the original world JSON into `data.character_book.originalData`-style content
   (it stores `file.originalData` verbatim when the world file was itself imported from a card).
2. Otherwise the book can be explicitly imported by the user ("Import Card Lore"): `convertCharacterBook()` maps
   each entry into a world-info entry, saved as `worlds/<book name>.json` with
   `bookName = data.character_book.name || `${character.name}'s Lorebook``.

Card-entry → world-info-entry mapping (`convertCharacterBook`), with defaults:

| World-info key | Card source | Default |
| --- | --- | --- |
| `uid` | `entry.id` | index (`entry.id = index` if missing) |
| `key` | `entry.keys` | — |
| `keysecondary` | `entry.secondary_keys` | `[]` |
| `comment` | `entry.comment` | `''` |
| `content` | `entry.content` | — |
| `constant` | `entry.constant` | `false` |
| `selective` | `entry.selective` | `false` |
| `order` | `entry.insertion_order` | — |
| `position` | `entry.extensions.position ?? (entry.position === 'before_char' ? 0 : 1)` | `0`/`1` |
| `disable` | `!entry.enabled` | — |
| `displayIndex` | `entry.extensions.display_index` | index |
| `probability` | `entry.extensions.probability` | `100` |
| `useProbability` | `entry.extensions.useProbability` | `true` |
| `depth` | `entry.extensions.depth` | `4` |
| `selectiveLogic` | `entry.extensions.selectiveLogic` | `0` (AND_ANY) |
| `outletName` | `entry.extensions.outlet_name` | `''` |
| `group` | `entry.extensions.group` | `''` |
| `groupOverride` | `entry.extensions.group_override` | `false` |
| `groupWeight` | `entry.extensions.group_weight` | `100` |
| `scanDepth` | `entry.extensions.scan_depth` | `null` |
| `caseSensitive` | `entry.extensions.case_sensitive` | `null` |
| `matchWholeWords` | `entry.extensions.match_whole_words` | `null` |
| `useGroupScoring` | `entry.extensions.use_group_scoring` | `null` |
| `automationId` | `entry.extensions.automation_id` | `''` |
| `role` | `entry.extensions.role` | `0` (system) |
| `vectorized` | `entry.extensions.vectorized` | `false` |
| `sticky` / `cooldown` / `delay` | same names | `null` |
| `match*` flags | `match_persona_description`, `match_character_description`, `match_character_personality`, `match_character_depth_prompt`, `match_scenario`, `match_creator_notes` | `false` |
| `triggers` | `entry.extensions.triggers` | `[]` |
| `ignoreBudget` | `entry.extensions.ignore_budget` | `false` |

Reverse mapping (`convertWorldInfoToCharacterBook`, used when writing a card from a linked world) emits
`{id: uid, keys: key, secondary_keys: keysecondary, comment, content, constant, selective,
insertion_order: order, enabled: !disable, position: position == 0 ? 'before_char' : 'after_char', use_regex: true,
extensions: {...entry.extensions, position, exclude_recursion, display_index, probability, useProbability, depth (default 4),
selectiveLogic (0), outlet_name (''), group (''), group_override, group_weight, prevent_recursion,
delay_until_recursion, scan_depth, match_whole_words, use_group_scoring, case_sensitive, automation_id, role (0),
vectorized, sticky, cooldown, delay, match_*, triggers ([]), ignore_budget}}`
plus `{entries, name}` at book level.

World-info position enum: `before:0, after:1, ANTop:2, ANBottom:3, atDepth:4, EMTop:5, EMBottom:6, outlet:7`.
Logic enum: `AND_ANY:0, NOT_ALL:1, NOT_ANY:2, AND_ALL:3`.

---

# 5. Example-message ("<START>") blocks

## 5.1 Canonical card value

`data.mes_example` is a **single raw string**, conventionally one or more blocks each beginning with the literal token
`<START>`:

```
<START>
{{user}}: Hi!
{{char}}: *waves* Hello.
<START>
{{user}}: Describe yourself.
{{char}}: I'm ...
```

There is no JSON structure inside `mes_example`; blocks are delimited purely by `<START>` (case-insensitive when
splitting: `/<START>/gi`).

## 5.2 `parseMesExamples(examplesStr, isInstruct)` — the tokenizer block builder

Exact algorithm (`public/script.js`):

```ts
if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return [];
if (!examplesStr.startsWith('<START>')) examplesStr = '<START>\n' + examplesStr.trim();

const exampleSeparator = power_user.context.example_separator
  ? `${substituteParams(power_user.context.example_separator)}\n` : '';
const blockHeading = (main_api === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator;

return examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
```

So:

* Chat completion / instruct mode: each block becomes exactly `"<START>\n" + trimmedBlock + "\n"`.
* Plain text completion: each block becomes exactly `"***\n" + trimmedBlock + "\n"` (default separator `'***'`),
  i.e. `<START>` is **removed**, not replaced by the separator as a token.
* Leading text before the first `<START>` is discarded (`.slice(1)`).
* Each returned element is therefore a ready-to-concatenate string; `mesExamplesArray.join('')` is the
  `{{mesExamples}}` macro value and the `mesExmString` piece of a text-completion prompt.
* `mesExamplesRawArray` is a copy taken **before** instruct-mode reformatting (used by `{{mesExamplesRaw}}`).

## 5.3 Instruct mode reformatting (`formatInstructModeExamples`)

For each parsed block:

```
cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '')
blockExamples = parseExampleIntoIndividual(cleanedItem, includeGroupNames)
```

then, for every resulting message:

```
prefix = example.name === 'example_user' ? instruct.input_sequence  : instruct.output_sequence
suffix = example.name === 'example_user' ? instruct.input_suffix    : instruct.output_suffix
name   = example.name === 'example_user' ? name1 : name2
text   = includeThisName ? `${name}: ${content}` : content
line   = [prefix, text + suffix].filter(Boolean).join(instruct.wrap ? '\n' : '')
```

A block heading (the example separator + `\n`, if set) is pushed once per block before its messages.
Defaults (`power_user.instruct`): `input_sequence '### Instruction:'`, `output_sequence '### Response:'`,
`input_suffix ''`, `output_suffix ''`, `wrap true`, `macro true`, `names_behavior FORCE`, `enabled false`.
With `skip_examples` on, blocks are only re-headed: `x.replace(/<START>\n/i, blockHeading)`.

## 5.4 `parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true)`

Used by chat completion (`setOpenAIMessageExamples` → each block first `replace(/<START>/i, '{Example Dialogue:}')`,
then `\r` removed) and instruct mode. Exact semantics:

1. Split on `'\n'`.
2. **Skip line index 0** (comment in code: *"skip first line as it'll always be 'This is how {bot name} should talk'"*).
   This is why the `<START>`/`{Example Dialogue:}` heading line disappears.
3. A line starting with `` `${name1}:` `` switches to "user" mode; starting with `` `${name2}:` `` (or
   `` `${groupMemberName}:` ``) switches to "bot" mode. The switch flushes the previous message.
4. Accumulate all lines (including the speaker-prefix line) into `cur_msg_lines`.
5. Flush (`add_msg`) joins with `'\n'`, then `parsed_msg = joined.replace(name + ':', '').trim()` — the speaker prefix
   is removed by a plain string replace of the first occurrence of `` `${name}:` `` anywhere in the block.
6. Output objects: `{ role: 'system', content: parsed_msg, name: 'example_user' | 'example_assistant' }`.
   In groups with `appendNamesForGroup`, content is re-prefixed `` `${name}: ` ``.
7. A trailing open user/bot block is flushed at the end.

Resulting chat-completion sequence for one `<START>` block:

```
system: "[Example Chat]"                // new_example_chat_prompt, default '[Example Chat]'
system(name=example_user):      "Hi!"
system(name=example_assistant): "Hello."
```

All example messages are role `system` (with `name` set) and are placed at the `dialogueExamples` marker.
With `power_user.pin_examples = false` (default) they are inserted **after** chat history (i.e. appended near the end,
budget permitting); with `pin_examples = true` they are inserted **before** chat history. `power_user.strip_examples`
(default false) drops them from the text-completion prompt after the story string was rendered.

---

# 6. Chat files and character state

## 6.1 Chat file format

* Location: `chats/<character file name without .png>/<chat name>.jsonl` (group: `group chats/<group chat id>.jsonl`).
* Format: **one JSON object per line**, first line is a header, remaining lines are messages.
* Header (`ChatHeader`):

```jsonc
{ "chat_metadata": { /* ChatMetadata */ }, "user_name": "unused", "character_name": "unused" }
```

  `user_name`/`character_name` are literally `'unused'` (marked `@deprecated For backward compatibility ONLY`).
* Save writes `[chatHeader, ...messages].map(m => JSON.stringify(m)).join('\n')` (no trailing newline).
* `chat_metadata.integrity` is a UUID generated once when a chat is first saved (`script.js`: if
  `!chat_metadata.integrity → uuidv4()`). On save the server compares the incoming slug with the file's existing
  `chat_metadata.integrity`; mismatch → API error `integrity` and the client asks the user to confirm overwrite.
* `chat_metadata.tainted = true` marks metadata modified after chat start (affects "are you sure" prompts).

`ChatMetadata` (documented shape, any extra keys allowed):

```ts
interface ChatMetadata {
  tainted?: boolean;
  integrity?: string;
  scenario?: string;        // per-chat override of character scenario
  persona?: string;         // avatar id of the persona locked to this chat
  system_prompt?: string;   // per-chat override of character system_prompt
  mes_example?: string;     // per-chat override of mes_example
  [key: string]: any;       // note_*, world_info, variables, attachments, …
}
```

The three text overrides are used *in preference to* the card in `getCharacterCardFields`
(`chat_metadata.system_prompt || character.data.system_prompt`, etc.).

`ChatMessage`:

```ts
interface ChatMessage {
  name?: string;
  mes?: string;
  title?: string;
  gen_started?: string | number | Date;
  gen_finished?: string | number | Date;
  send_date?: string | number | Date;
  is_user?: boolean;
  is_system?: boolean;
  force_avatar?: string;     // e.g. a persona thumbnail URL
  original_avatar?: string;
  swipes?: string[];
  swipe_info?: { send_date?; gen_started?; gen_finished?; extra?: ChatMessageExtra }[];
  swipe_id?: number;
  extra?: {                  // BaseMessageExtra + Record<string, any>
    api?: string; model?: string; type?: string; gen_id?: number; bias?: string;
    display_text?: string; reasoning?: string; reasoning_signature?: string | null;
    reasoning_display_text?: string; tool_invocations?: unknown[];
    token_count?: number; files?: unknown[]; media?: unknown[]; inline_image?: boolean;
    media_display?: string; media_index?: number; isSmallSys?: boolean; title?: string;
    [IGNORE_SYMBOL]?: boolean;   // Symbol.for('ignore') — excluded from prompt
  };
}
```

New messages: user message `{name, is_user:true, is_system:false, send_date, mes, extra:{isSmallSys}}`, assistant reply
`{name, is_user:false, is_system:false, send_date, mes, extra:{...}}` with swipes.

## 6.2 Chat naming and "character state"

* `character.chat` (loaded from the card, flat + `data` copies) holds the **current** chat name without `.jsonl`.
  On first use the server assigns `"<name> - <humanizedDateTime()>"`.
* Character list items returned by `POST /api/characters/all` are the card object plus computed state:

| Field | Source |
| --- | --- |
| `avatar` | PNG file name |
| `json_data` | raw card JSON string |
| `date_added` | `stat.ctimeMs` of the PNG |
| `create_date` | card `create_date` or `new Date(ctimeMs).toISOString()` |
| `chat_size` | total bytes of all files in the character's chat dir |
| `date_last_chat` | max mtime in the chat dir |
| `data_size` | sum of `String(v).length` for all values of `data` |
| `shallow` | `true` for list responses when `performance.lazyLoadCharacters`; only `name, avatar, chat, fav, date_added, create_date, date_last_chat, chat_size, data_size, tags` and `data.{name,character_version,creator,creator_notes,tags,extensions.fav,extensions.world}` are present |

* Deleting a character optionally deletes `chats/<name>/` (`delete_chats: true`).
* Renaming rewrites `data.name` + `name`, writes a new PNG, and moves the chat folder.
* Duplicating copies the PNG to `<base>_<n>.png`.
* Expressions/sprites and CharX backgrounds live **inside the character folder**, not in the chat file:
  `characters/<character name>/*.png`, `characters/<character name>/backgrounds/*`.

---

# 7. TypeScript interfaces to implement

```ts
export interface CardV1 {
  name: string; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string;
  creatorcomment?: string; creator_notes?: string; avatar?: string; chat?: string;
  talkativeness?: number | string; fav?: boolean; tags?: string[] | string;
  create_date?: string; data?: CardV2Data; [k: string]: unknown;
}

export interface CardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: CardV2Data;
  [k: string]: unknown;           // legacy flat duplicates are written as well
}

export interface CardV2Data {
  name: string; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string;
  creator_notes: string; system_prompt: string; post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[]; creator: string; character_version: string;
  extensions: {
    talkativeness?: number; fav?: boolean; world?: string;
    depth_prompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' };
    regex_scripts?: RegexScriptData[];
    [k: string]: unknown;
  };
  character_book?: CharacterBook;
  group_only_greetings?: string[];
  assets?: CharXAsset[];
  [k: string]: unknown;
}

export interface CardV3 { spec: 'chara_card_v3'; spec_version: string; data: Record<string, unknown>; }
```

---

# Open questions

1. **Full V3 spec fields.** The checkout validates only `spec`, `spec_version ∈ [3.0, 4.0)`, and an object `data`.
   It never reads `group_only_greetings` (present as `[]` in the bundled card), `assets`, `nickname`,
   `creator_notes_multilingual`, `source`, or `creation_date`. Their types/semantics cannot be established from this
   code alone; the V3 document was not reachable (no network in this session).
2. **CHARX official spec.** Only the importer's assumptions are documented above. The full list of allowed `type`
   values, whether `assets` is required, and the exact `card.json` version requirement are unknown. `card.json` is
   matched by `endsWith('card.json')`, so nested locations are accepted by this implementation, but that may not be
   spec-compliant.
3. **`chara`/`ccv3` chunk placement.** ST writes them **after IDAT**. Whether other readers require text chunks
   before IDAT is not verifiable here.
4. **`png-chunk-text` internals.** `node_modules` is absent in the checkout, so the exact byte handling of
   `PNGtext.encode/decode` (Latin-1 conversion, keyword validation) is inferred from the PNG spec, not read.
5. **`use_regex: true`** is hard-coded by `convertWorldInfoToCharacterBook` ("ST keys are always regex") although the
   V2 spec treats it as optional; its downstream meaning (whether keys are regexes or literals) is implemented in the
   world-info scanner, which was out of scope.
6. **`extensions.position` numeric vs `position` string** in `character_book` entries: ST prefers
   `entry.extensions.position`, otherwise maps `'before_char' → 0`, anything else `→ 1`. The V2 spec only defines the
   string, so foreign cards with `extensions.position` values 2–7 follow ST's own enum.
7. **`talkativeness` type**: ST writes a number but the bundled card stores `"0.5"`; code reads either. `fav` is
   compared with `== 'true'` (string) on the form path, so `false`/`"false"` behave as false.
8. **Group/character-card merging.** `getGroupCharacterCards()` combines several members' `description`, `personality`,
   `scenario`, `mesExamples` and per-member depth prompts. The exact join format was not fully traced and is only
   referenced where it overrides a field.
9. **`group_only_greetings`** is not consumed anywhere; its intended UI behaviour is therefore unverified.
10. **V1 `spec` values.** Cards carrying `spec: 'chara_card_v1'` fail V2 validation (`spec` mismatch) and are then
    treated as V1 only if the flat required fields exist; ST itself never writes a `spec` for V1.

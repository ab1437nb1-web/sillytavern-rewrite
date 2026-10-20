# SillyTavern Preset Systems — Re-implementation Spec

Target: SillyTavern **1.19.0** (`package.json` `1.19.0`, commit `06bde939f`).

Primary sources (line numbers refer to these unless stated otherwise):

| File | Role |
| --- | --- |
| `public/scripts/PromptManager.js` (2144 lines) | `Prompt`, `PromptCollection`, `PromptManager`, default prompts/orders |
| `public/scripts/openai.js` (7396 lines) | prompt assembly for Chat Completion, `Message`/`MessageCollection`/`ChatCompletion`, preset ↔ settings mapping, request payload |
| `public/scripts/power-user.js` | context template controls + defaults, `renderStoryString()`, custom stop strings |
| `public/scripts/instruct-mode.js` | instruct template fields, formatting functions, stop sequences |
| `public/scripts/preset-manager.js` | generic preset CRUD/import/export, master import, per-API adapters |
| `public/script.js` | `Generate()` (the only caller of `prepareOpenAIMessages`), extension prompts, stop strings, character-card fields |
| `src/endpoints/presets.js`, `src/endpoints/content-manager.js` | on-disk preset I/O and default-preset seeding |
| `src/prompt-converters.js`, `src/endpoints/backends/chat-completions.js` | server-side request transforms (Claude/Gemini/Mistral…) |
| `default/content/presets/**`, `default/content/settings.json` | shipped templates + default settings |

Naming corrections to the brief (verified in source, not assumptions):

* There is **no `getPromptManagerSettings()`**, no `constructPrompt()` and no `populateChatCompletion` *renamed* API in this checkout. The real entry points are
  `prepareOpenAIMessages()` → `preparePromptsForChatCompletion()` → `populateChatCompletion()` (openai.js:1542, :1367, :1185).
* The context-template flag is **`use_stop_strings`** (not `use_stop_sequence`); instruct templates use `stop_sequence` (singular).
* There is **no `activation_regex` on context templates**. It exists only on instruct templates (`instruct-mode.js:42`, `:262`).
* A prompt entry has **no `enabled` field of its own** — `enabled` lives on the `prompt_order` entry that references the prompt identifier (§2.1).
* `constructPrompt()` exists only in unrelated text-completion helpers (`public/scripts/custom-request.js:198`, `public/scripts/extensions/shared.js:501`).

---

## 0. Executive summary

Three **independent** JSON files, each selected separately, each stored in its own folder:

```
                          ┌────────────────────────────────────────────────┐
 Chat Completion preset   │ sampler params + connection + prompts[]         │  data/<user>/OpenAI Settings/*.json
 (openai/Default.json)    │ + prompt_order[] (ordered identifiers)          │  (/api/presets/save {apiId:'openai'})
                          └───────────────┬────────────────────────────────┘
                                          │ promptOrder (dummyId 100001)
                                          ▼
 Prompt manager  ── prompts + order ──► ordered PromptCollection
                                          │  markers replaced by runtime character/WI/persona values
                                          │  absolute (in-chat) entries → depth injections
                                          ▼
                                   messages[]  {role, content, name?}  ──► POST /api/backends/chat-completions/generate

 Context template     ── story_string (Handlebars) + separators + stop-string flags ──► **text-completion APIs only**
 (context/Default.json)                                                              (main_api !== 'openai')

 Instruct template    ── sequences/suffixes/wrap/skip_examples ──► **text-completion APIs only**
 (instruct/ChatML.json)                                           (chat completion ignores both, see §7)
```

The single most important architectural fact for a re-implementation: **Chat Completion does not use the context
template's `story_string` and does not use the instruct template at all.** The story string is a Text-Completion
construct; in Chat Completion the same information is emitted as separate messages driven by the prompt manager's
*markers*. The three templates are linked only by UI conventions (`bind_to_context`, model→template mappings) and by
shared settings objects — not by the prompt pipeline. Details and proof in §1.6, §5.7, §7.3.

---

## 1. Context template (context preset)

### 1.1 Storage, loading, saving

* Folder: `directories.context` → `data/<user>/context/` (`src/endpoints/presets.js:29-30`); shipped defaults in
  `default/content/presets/context/*.json` are seeded there by `content-manager.js` (`getDefaultPresets()` matches
  content-item types `instruct | context | sysprompt | reasoning`, `content-manager.js:86-104`).
* Save: `POST /api/presets/save` with `{ apiId: 'context', name, preset }` → writes `sanitize(name) + '.json'`,
  pretty-printed with 4 spaces, atomically (`presets.js:42-58`).
* Restore default: `POST /api/presets/restore` `{apiId, name}` returns `{isDefault, preset}` from the shipped file.
* Client-side: `preset-manager.js` `PresetManager.savePreset()` / `getPresetSettings()` (`:473`, `:647`).
  For `apiId === 'context'` the settings object is `getContextSettings()` with `name` injected (`:657-661`).
* The selected template name lives in `power_user.context.preset` (string, default `"Default"`), *not* in the file.
* Applying a template (`power-user.js:2037-2075`):

```js
const presetValue = preset[control.property] ?? control.defaultValue;   // missing field → control default
if (presetValue !== undefined) { … power_user.context[prop] = presetValue … }
// global settings (always_force_name2, trim_sentences, single_line) are written to power_user[prop], not context
```

### 1.2 Every field

`getContextSettings()` iterates exactly `contextControls` (`power-user.js:354-369`), so **these 11 keys are the
complete on-disk schema**, plus `name`:

| JSON key | JS type | Default (power_user, `power-user.js:247-257`) | Control default used when the file omits it | Runtime meaning |
| --- | --- | --- | --- | --- |
| `story_string` | string | `defaultStoryString` (`:90`) | — (kept as-is) | Handlebars template, see §1.4 |
| `example_separator` | string | `'***'` (`:251`) | — | Text placed before each example block (`<START>` replacement). Also a stop string when `use_stop_strings` |
| `chat_start` | string | `'***'` (`:250`) | — | Text between story string / examples and the chat. Also a stop string when `use_stop_strings` |
| `use_stop_strings` | boolean | `true` (`:252`) | `false` | Add `\n` + `chat_start` and `\n` + `example_separator` to the stop list |
| `names_as_stop_strings` | boolean | `true` (`:253`) | `true` | Add `\n<name>:` stops (and group member names) |
| `story_string_position` | number | `extension_prompt_types.IN_PROMPT` = `0` | `0` | `0` in-prompt, `1` in-chat (depth injection), `2` before-prompt (text completion only) |
| `story_string_depth` | number | `1` (`:256`) | `1` | Depth when `story_string_position === 1` |
| `story_string_role` | number | `extension_prompt_roles.SYSTEM` = `0` | `0` | Role when injected in-chat: `0` system, `1` user, `2` assistant |
| `always_force_name2` | boolean | `true` (`:366`, global) | `true` | Always prefix the character name in text-completion prompts |
| `trim_sentences` | boolean | `false` (`:367`, global) | `false` | Trim generation to the last complete sentence |
| `single_line` | boolean | `false` (`:368`, global) | `false` | `\n` becomes a stop string (`script.js:3061-3063`) |
| `name` | string | filename | — | Written on save only; used as the `<option>` label |

Enums: `extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }` (`script.js:484-489`),
`extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 }` (`script.js:494-498`).

### 1.3 Exact shipped templates

`default/content/presets/context/Default.json` — **verbatim** (the story string is one JSON line; decoded value below):

```json
{
    "story_string": "{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}{{#if scenario}}{{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}{{trim}}",
    "example_separator": "***",
    "chat_start": "***",
    "use_stop_strings": false,
    "names_as_stop_strings": true,
    "story_string_position": 0,
    "story_string_depth": 1,
    "story_string_role": 0,
    "always_force_name2": true,
    "trim_sentences": false,
    "single_line": false,
    "name": "Default"
}
```

The same template with real newlines (this is the string you must reproduce byte-for-byte):

```
{{#if anchorBefore}}{{anchorBefore}}
{{/if}}{{#if system}}{{system}}
{{/if}}{{#if wiBefore}}{{wiBefore}}
{{/if}}{{#if description}}{{description}}
{{/if}}{{#if personality}}{{personality}}
{{/if}}{{#if scenario}}{{scenario}}
{{/if}}{{#if wiAfter}}{{wiAfter}}
{{/if}}{{#if persona}}{{persona}}
{{/if}}{{#if anchorAfter}}{{anchorAfter}}
{{/if}}{{trim}}
```

`ChatML.json` / `Minimalist.json` use the identical `story_string` but `"example_separator": ""`, `"chat_start": ""`.
`OldDefault.json` differs in three places:

```
{{#if personality}}{{char}}'s personality: {{personality}}      (instead of {{personality}})
{{#if scenario}}Circumstances and context of the dialogue: {{scenario}}
"example_separator": "This is how {{char}} should talk",
"chat_start": "\nThen the roleplay chat between {{user}} and {{char}} begins.\n",
```

Two other defaults that matter (they are *not* the shipped `Default.json`):

* Built-in `power_user.context.story_string` (`power-user.js:90`):
  `{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}`
  — no anchors, no `wiBefore`/`wiAfter`, no `{{trim}}`.
* `default/content/settings.json:179` ships a third variant (same as above plus
  `{{#if wiBefore}}…{{/if}}` before description and `{{#if wiAfter}}…{{/if}}` after scenario).

### 1.4 How `story_string` is interpolated

`renderStoryString(params, {customStoryString, customInstructSettings, customContextSettings})` (`power-user.js:2234-2269`):

```js
const compiledTemplate = Handlebars.compile(storyString, { noEscape: true });   // HTML escaping OFF
let output = compiledTemplate(params);                                          // 1. Handlebars render
output = substituteParams(output, params.user, params.char);                    // 2. macro pass ({{char}}, {{user}}, {{trim}}, custom macros)
output = output.replace(/^\n+/, '');                                            // 3. strip leading newlines
if (output.length && !output.endsWith('\n') && storyStringPosition !== IN_CHAT) {
    if (!instruct.enabled || (instruct.wrap && !instruct.story_string_suffix)) output += '\n';   // 4. trailing newline
}
```

Consequences: `{{#if x}}…{{/if}}` is a **real Handlebars block** (truthiness of the param; empty string ⇒ block
omitted, together with its trailing `\n`). `{{field}}` is plain interpolation with no escaping. Unknown
`{{macros}}` inside the template are left alone by Handlebars and resolved in step 2:

* `Handlebars.registerHelper('trim', () => '{{trim}}')` (`macros.js:19`) — `{{trim}}` survives compilation as the
  literal text `{{trim}}`, which the macro engine then deletes **together with surrounding newlines**
  (`/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi` → `''`, `macros.js:633`, `MacroEngine.js:311-314`).
* `Handlebars.registerHelper('helperMissing', …)` (`macros.js:21-25`) returns `substituteParams('{{name}}')`, so any
  unknown helper/macro is macro-expanded rather than throwing.

Parameters (built in `script.js:4703-4719`, immediately before the render):

| Param | Value |
| --- | --- |
| `description` | character description (`getCharacterCardFields()`, trimmed, macros applied; group-card override) |
| `personality` | character personality (same rules) |
| `persona` | `power_user.persona_description` **only if** `power_user.persona_description_position === IN_PROMPT (0)`, else `''` |
| `scenario` | `chat_metadata.scenario ?? character.scenario`, trimmed, macros applied |
| `system` | `chat_metadata.system_prompt ?? character.data.system_prompt`, trimmed, if `power_user.prefer_character_prompt`; later replaced by the sysprompt for TC APIs (`script.js:4687-4697`) |
| `char` | `name2` (character name) |
| `user` | `name1` (persona name) |
| `wiBefore` / `wiAfter` | world-info strings (`before_char` / `after_char` buckets) |
| `loreBefore` / `loreAfter` | legacy aliases of `wiBefore` / `wiAfter` |
| `anchorBefore` / `anchorAfter` | `(await getExtensionPrompt(BEFORE_PROMPT)).trim()` / `(await getExtensionPrompt(IN_PROMPT)).trim()` — i.e. Author's Note / summary-style extension prompts |
| `mesExamples` | `mesExamplesArray.join('')` (raw, unformatted) |
| `mesExamplesRaw` | `mesExamplesRawArray.join('')` |

Validation / self-healing:

* `validateStoryString()` (`power-user.js:2277-2317`) warns (once per template hash, cached in `accountStorage`
  `StoryStringValidationCache`) when `description`, `personality`, `persona`, `scenario`, `wiBefore|loreBefore`,
  `wiAfter|loreAfter` would have content but the template does not contain the placeholder. Warning only.
* `autoFixStoryString()` (`power-user.js:1949-1981`) migrates pre-1.12 templates: if the template has **no**
  `story_string_position` key, it injects `{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}` at the first `{{` and
  `{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}` at `min(lastIndexOf('{{trim}}'), lastIndexOf('}}')+2)`.

### 1.5 Render order in the text-completion prompt

`script.js:4722-4735` — the rendered story string is then optionally wrapped by the instruct template and *then*
injected:

```js
const storyString = renderStoryString(storyStringParams);
let combinedStoryString = isInstruct ? formatInstructModeStoryString(storyString) : storyString;
if (main_api !== 'openai' && power_user.context.story_string_position === IN_CHAT) {
    setExtensionPrompt(inject_ids.STORY_STRING, combinedStoryString, IN_CHAT, depth, false, role);
    combinedStoryString = '';               // de-duplicate
}
```

Final TC prompt = `combinedStoryString + examplesString + chatString + generatedPromptCache`
(`script.js:5192-5197`), with `\r` removed and optional newline collapsing.

### 1.6 Where the context template does / does not apply

* **Text-completion APIs** (kobold, textgenerationwebui, novel): full effect as above.
* **Chat Completion** (`main_api === 'openai'`): `openai.js` contains **zero** references to `power_user.context`,
  `context.preset` or `power_user.instruct` (grep-verified). `prepareOpenAIMessages()` never calls
  `renderStoryString()`, and `script.js:4726` explicitly excludes `openai` from story-string depth injection.
  Therefore in CC the context template is inert except for the shared `power_user` booleans it can overwrite
  (`always_force_name2`, `trim_sentences`, `single_line`) and `names_as_stop_strings` / `use_stop_strings`, which
  `getStoppingStrings()` ignores for CC anyway (`script.js:3025-3029`: *"Only custom stop strings apply to Chat
  Completion"*).
* A re-implementation that only targets CC can therefore ship the context template as **metadata + TC support**;
  it must not be wired into message assembly.

---

## 2. Prompt manager entry model

### 2.1 Where entries and order live

Both live inside the **chat completion preset** (`oai_settings.prompts`, `oai_settings.prompt_order`) — there is no
separate "prompt manager" file (`settingsToUpdate` entries `prompts`/`prompt_order`, `openai.js:377-378`).

```jsonc
"prompts": [
  { "identifier": "main", "name": "Main Prompt", "system_prompt": true, "role": "system",
    "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}." },
  { "identifier": "dialogueExamples", "name": "Chat Examples", "system_prompt": true, "marker": true },
  { "identifier": "enhanceDefinitions", "name": "Enhance Definitions", "role": "system",
    "content": "If you have more knowledge of {{char}}, …", "system_prompt": true, "marker": false }
],
"prompt_order": [
  { "character_id": 100001, "order": [ { "identifier": "main", "enabled": true }, … ] }
]
```

* `prompt_order` is an array of `{ character_id, order: [{ identifier, enabled }] }`. Lookup is by **string**
  comparison: `String(list.character_id) === String(character.id)` (`PromptManager.js:1207-1209`).
* The CC prompt manager is configured `{ strategy: 'global', dummyId: 100001 }` (`openai.js:696-699`), so the
  authoritative block is the one with `character_id === 100001`. `Default.json` ships **both** `100000` (legacy) and
  `100001`; `default/content/settings.json` ships only `100000`, so a fresh install has an empty `100001` list and
  `sanitizeServiceSettings()` seeds it from `promptManagerDefaultPromptOrder` (`PromptManager.js:1010-1015`,
  `:2087-2136`).
* Missing order array for the active character ⇒ **empty collection** (nothing is ordered ⇒ nothing is emitted).
* `PromptManager` defaults if `prompts` is empty: `chatCompletionDefaultPrompts.prompts`; missing built-in
  identifiers are re-appended by `checkForMissingPrompts()` (`:1043-1057`); identifiers that no prompt defines are
  dropped from the order by `sanitizeServiceSettings()` (`:1025-1034`); prompts without an identifier get a UUID
  (`:1023`).

### 2.2 Entry schema

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `identifier` | string | uuid v4 for user prompts | Primary key, referenced by `prompt_order`. Built-ins have fixed ids (§2.3) |
| `name` | string | `''` | UI label only |
| `system_prompt` | boolean | `false` for new prompts (`addPrompt`, `:991-997`) | **Dispatch flag**, not a role. `true` = built-in/managed marker (never treated as a user-relative prompt, §3.4); `false` = user prompt emitted after the marker block |
| `role` | `'system' \| 'user' \| 'assistant'` | `undefined` for pure markers ⇒ `Message` ctor falls back to `'system'` (`openai.js:3543-3546`) | Copied onto the runtime prompt at merge time (§3.3) |
| `content` | string | `''`; `undefined` for markers | Macros are expanded at assembly time, not at edit time |
| `injection_position` | number | `undefined` ⇒ treated as `0` | `INJECTION_POSITION.RELATIVE = 0`, `ABSOLUTE = 1` (`PromptManager.js:37-40`) |
| `injection_depth` | number | `DEFAULT_DEPTH = 4` (UI default, `:31`, `:565`) | ABSOLUTE only: `0` = after the newest message |
| `injection_order` | number | `DEFAULT_ORDER = 100` (`:32`; ctor `?? 100`) | ABSOLUTE only: tie-break bucket at equal depth |
| `injection_trigger` | string[] | `[]` (`:194`) | If non-empty, entry only fires for listed generation types (`normal`, `continue`, `impersonate`, `quiet`, …) — `shouldTrigger()`, `:1549-1553` |
| `forbid_overrides` | boolean | `undefined` ⇒ falsy | Only honoured for `main` and `jailbreak`: blocks character-card `system_prompt` / `post_history_instructions` override (`openai.js:1498`, `:1508`) |
| `marker` | boolean | `false`; `true` on built-in markers | UI/behaviour flag read from the raw object (not on the `Prompt` class): marker ⇒ content textarea disabled, never exported as a user prompt, delete forbidden with `system_prompt`, toggle allowed only for the whitelist |
| `extension` | boolean | `false` (`:192`) | Set by the assembler for third-party extension prompts; `extension && position` ⇒ relative insert (§3.4) |
| `enabled` | — | — | **Not stored on the prompt.** `{identifier, enabled}` entry in `prompt_order.order`; read via `getPromptOrderEntry()` / `isPromptDisabledForActiveCharacter()` (`:949-953`) |

`Prompt` class field list (constructor `:182-195`) additionally has `position` (`'start' | 'end'`, extension prompts
only) — it is not persisted in presets.

Whitelists worth copying:

```js
overridablePrompts = ['main', 'jailbreak']                                   // :320-323
isPromptDeletionAllowed  = !prompt.system_prompt                             // :1073-1075
isPromptEditAllowed      = forceEdit.includes(id) || !prompt.marker          // forceEdit: charDescription, charPersonality,
                                                                            //   scenario, personaDescription, worldInfoBefore, worldInfoAfter
isPromptToggleAllowed    = (prompt.marker && !forceToggle.includes(id)) ? false : !toggleDisabled.includes(id)
// forceToggle: charDescription, charPersonality, scenario, personaDescription,
//              worldInfoBefore, worldInfoAfter, main, chatHistory, dialogueExamples   (:1099-1112)
```

`PromptCollection` is a thin ordered list: `collection: Prompt[]`, `add/set/get/index/has/override(prompt, pos)`;
`override()` also pushes the identifier into `overriddenPrompts` (displayed in the UI, `:294-297`).

### 2.3 Built-in identifiers and what they resolve to at runtime

Values are produced by `preparePromptsForChatCompletion()` (`openai.js:1367-1515`) unless noted.

| identifier | Default `name` | role | `system_prompt` | `marker` | Runtime content (source) |
| --- | --- | --- | --- | --- | --- |
| `main` | Main Prompt | system | true | false | preset `content` (default `Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.`, `PromptManager.js:2007`), **replaced** by the character card `system` field / sysprompt when `systemPromptOverride` is non-empty and `forbid_overrides !== true` |
| `nsfw` | Auxiliary Prompt | system | true | false | preset `content` (default `''`) |
| `jailbreak` | Post-History Instructions | system | true | false | preset `content` (default `''`), replaced by `character.data.post_history_instructions` when `jailbreakPromptOverride` and allowed |
| `enhanceDefinitions` | Enhance Definitions | system | true | **false** | preset `content` (default `If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.`) |
| `worldInfoBefore` | World Info (before) | system | true | true | `formatWorldInfo(worldInfoBefore)` — WI `before_char` bucket through `wi_format` |
| `worldInfoAfter` | World Info (after) | system | true | true | `formatWorldInfo(worldInfoAfter)` — `after_char` bucket |
| `charDescription` | Char Description | system | true | true | `charDescription` = `character.description` (group-card aware, trimmed) |
| `charPersonality` | Char Personality | system | true | true | `substituteParams(oai_settings.personality_format)` if personality non-empty, i.e. default `{{personality}}` |
| `scenario` | Scenario | system | true | true | `substituteParams(oai_settings.scenario_format)` if scenario non-empty, i.e. default `{{scenario}}` |
| `personaDescription` | Persona Description | system | true | true | `power_user.persona_description`, **only if** `persona_description_position === IN_PROMPT (0)` (`:1433-1435`) |
| `dialogueExamples` | Chat Examples | (n/a) | true | true | Handled by `populateDialogueExamples()` — example blocks from `character.mes_example`, each prefixed with `new_example_chat_prompt` |
| `chatHistory` | Chat History | (n/a) | true | true | Handled by `populateChatHistory()` — the real chat messages |
| `impersonate` | — | system | (n/a) | — | `substituteParams(oai_settings.impersonation_prompt)`; emitted only for `type === 'impersonate'`, always last |
| `quietPrompt` | — | system | (n/a) | — | `quiet_prompt` argument (extension side prompt); always second-to-last |
| `groupNudge` | — | system | (n/a) | — | `substituteParams(oai_settings.group_nudge_prompt)`; group chats only, appended at the **end** of `chatHistory` |
| `bias` | — | **assistant** | (n/a) | — | `promptBias` (user "start reply with" / message bias) |
| `summary` | — | from extension (`1_memory.role`) | (n/a) | — | Vector/tavern-extras summary, relative insert |
| `authorsNote` | — | from extension (`2_floating_prompt.role`) | (n/a) | — | Author's Note, relative insert |
| `vectorsMemory` | — | **system** (hardcoded) | (n/a) | — | `3_vectors` |
| `vectorsDataBank` | — | from extension (`4_vectors_data_bank.role`) | (n/a) | — | `4_vectors_data_bank` |
| `smartContext` | — | **system** (hardcoded) | (n/a) | — | `chromadb` |
| *(any other extension key)* | — | extension's role | (n/a) | extension: true | `identifier = key.replace(/\W/g, '_')`, only when position is `BEFORE_PROMPT` or `IN_PROMPT` and `filter()` passes (`:1449-1467`) |
| `continueNudge` | — | system | (n/a) | — | `continue_nudge_prompt` with `{{lastChatMessage}}`, `type === 'continue'` only (§3.8) |

`formatWorldInfo(value, {wiFormat})` (`openai.js:789-801`): returns `''` for falsy; if `wi_format` is blank returns
the value verbatim; else `stringFormat(wi_format, value)` — a plain `{0}` substitution (`utils.js:756-763`). Default
`wi_format` is `"{0}"`, i.e. **no wrapper at all**.

---

## 3. Assembly algorithm (Chat Completion)

### 3.1 Inputs

```ts
prepareOpenAIMessages({
  name2, charDescription, charPersonality, scenario, worldInfoBefore, worldInfoAfter,
  bias, type, quietPrompt, quietImage, extensionPrompts, cyclePrompt,
  systemPromptOverride, jailbreakPromptOverride, messages, messageExamples
}, dryRun)   // openai.js:1542
```

Call site `script.js:5285-5302`: `charDescription/personality/scenario` come from `getCharacterCardFields()`,
`systemPromptOverride = system`, `jailbreakPromptOverride = jailbreak`, `messages = setOpenAIMessages(coreChat)`,
`messageExamples = setOpenAIMessageExamples(mesExamplesArray)`.

`setOpenAIMessages()` (`openai.js:570-649`) walks the chat **backwards** (`for i = chat.length-1 … 0`, index `j`
increasing), so `messages[0]` is the **newest** message and `messages[len-1]` the oldest:

```js
{ role: 'user' | 'assistant' | 'system',   // is_user ? 'user' : 'assistant'; NARRATOR messages are 'system'
  content,                                  // mes, minus \r, optionally prefixed with `${name}: ` per names_behavior
  name, media, mediaDisplay, mediaIndex, invocations, signature, reasoning }
```

`setOpenAIMessageExamples()` (`:656-667`) → `Array<Array<{role:'system', content, name:'example_user'|'example_assistant'}>>`,
one inner array per example block (`parseExampleIntoIndividual()`, `:729-787`).

### 3.2 Step 1 — ordered collection from `prompt_order`

`PromptManager.getPromptCollection(generationType)` (`PromptManager.js:1516-1541`):

```ts
generationType = String(generationType || 'normal').toLowerCase().trim();
for (const entry of getPromptOrderForCharacter(activeCharacter)) {   // activeCharacter = {id: 100001}
  const prompt = getPromptById(entry.identifier);
  if (!prompt) continue;                                             // dangling reference
  const allowedTrigger = entry.enabled && shouldTrigger(prompt, generationType);
  if (allowedTrigger)            collection.add(preparePrompt(prompt));
  else if (entry.identifier === 'main') {                            // keep a GMO-free placeholder for relative inserts
     const p = structuredClone(prompt); p.content = ''; collection.add(preparePrompt(p));
  }
}
```

`preparePrompt(prompt, original?)` (`:1277-1290`) = `new Prompt(prompt)` + `substituteParams(prompt.content, {original?})`
(+ `groupOverride` when in a group). So **macros are expanded here**, and the resulting `Prompt` keeps the preset's
`role`, `system_prompt`, `injection_position/-depth/-order`, `forbid_overrides`, `marker`.

### 3.3 Step 2 — merge runtime marker values, apply overrides

`preparePromptsForChatCompletion()` (`openai.js:1367-1515`):

1. Build `systemPrompts[]` in this literal order — `worldInfoBefore`, `worldInfoAfter`, `charDescription`,
   `charPersonality`, `scenario`, then **unordered** `impersonate`, `quietPrompt`, `groupNudge`, `bias`
   (role `assistant`), then optional `summary`, `authorsNote`, `vectorsMemory`, `vectorsDataBank`, `smartContext`,
   then `personaDescription` (conditional), then unknown extension prompts.
2. `const prompts = promptManager.getPromptCollection(type)` (§3.2).
3. For each runtime prompt:

```js
const collectionPrompt = prompts.get(prompt.identifier);
if (collectionPrompt) {                       // copy the user's per-entry placement/role choices onto the value
    prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
    prompt.injection_depth    = collectionPrompt.injection_depth    ?? prompt.injection_depth;
    prompt.injection_order    = collectionPrompt.injection_order    ?? prompt.injection_order;
    prompt.role               = collectionPrompt.role               ?? prompt.role;
}
const newPrompt = promptManager.preparePrompt(prompt);   // macro pass #2 over the runtime value
const markerIndex = prompts.index(prompt.identifier);
if (markerIndex !== -1) prompts.collection[markerIndex] = newPrompt;   // replaces value, keeps prompt_order index
else                    prompts.add(newPrompt);                        // appended at the end
```

4. Character override of `main`, then of `jailbreak`:

```js
if (systemPromptOverride && main && main.forbid_overrides !== true && !isPromptDisabledForActiveCharacter('main')) {
   const original = main.content; main.content = systemPromptOverride;
   prompts.override(promptManager.preparePrompt(main, original), prompts.index('main'));   // `original` feeds {{original}}
}
```

So: **the prompt_order index survives the merge** (this is what makes ordering work), while disabled entries stay in
the collection but are skipped during emission (§3.4). Extension prompts that are not in `prompt_order` land *after*
every ordered entry, at indices `len, len+1, …`.

### 3.4 Step 3 — emission order and index-based placement

`populateChatCompletion()` (`openai.js:1185-1347`). Helper:

```js
async function addToChatCompletion(source, target = null) {
  if (!prompts.has(source)) return;
  if (promptManager.isPromptDisabledForActiveCharacter(source) && source !== 'main') return;  // ← disabled skipped
  const prompt = prompts.get(source);
  if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) return;                      // ← absolute skipped here
  const index = target ? prompts.index(target) : prompts.index(source);
  const collection = new MessageCollection(source);
  collection.add(await Message.fromPromptAsync(prompt));
  chatCompletion.add(collection, index);
}
```

Call sequence (this is the literal order in the source):

```js
chatCompletion.reserveBudget(3);
addToChatCompletion('worldInfoBefore');
addToChatCompletion('main');
addToChatCompletion('worldInfoAfter');
addToChatCompletion('charDescription');
addToChatCompletion('charPersonality');
addToChatCompletion('scenario');
addToChatCompletion('personaDescription');

// control prompts (always last): impersonate (type==='impersonate'), quietPrompt
addToChatCompletion for [...['nsfw','jailbreak'], ...userRelativePrompts]        // see below
if (prompts.has('enhanceDefinitions')) addToChatCompletion('enhanceDefinitions');
if (bias && bias.trim())               addToChatCompletion('bias');

// relative extension prompts → inserted into 'main' (or converted to absolute, see below)
['summary','authorsNote','vectorsMemory','vectorsDataBank','smartContext']  // if prompt.position
prompts.collection.filter(p => p.extension && p.position)                    // any other extension prompt

// continue-prefill displacement, then:
messages = await populationInjectionPrompts(absolutePrompts, messages);      // §3.6
pin_examples ? (examples → history) : (history → examples)
chatCompletion.add(controlPrompts);                                          // push at the very end
```

where

```js
const systemPrompts = ['nsfw', 'jailbreak'];
const userRelativePrompts = prompts.collection
    .filter(p => p.system_prompt === false && p.injection_position !== INJECTION_POSITION.ABSOLUTE)
    .map(p => p.identifier);
const absolutePrompts = prompts.collection
    .filter(p => p.injection_position === INJECTION_POSITION.ABSOLUTE);
```

Two consequences a re-implementation must preserve:

1. **Relative (`injection_position = 0`) entries with `system_prompt: true` that are not in the hard-coded list are
   never emitted** — `system_prompt: true` means "value slot for a known marker", not "emit me". (Entries with
   `injection_position = 1` *are* emitted regardless of `system_prompt`, through `absolutePrompts` in §3.6.)
   User-created prompts get `system_prompt: false` (`addPrompt`, `PromptManager.js:991-997`) so they are emitted
   through `userRelativePrompts`.
2. **Position is decided solely by `chatCompletion.add(collection, index)`**, i.e. by the prompt's index in the
   ordered collection:

```js
add(collection, position = null) {
  this.validateMessageCollection(collection);
  this.checkTokenBudget(collection, collection.identifier);       // throws TokenBudgetExceededError
  if (position !== null && position !== -1) this.messages.collection[position] = collection;
  else this.messages.collection.push(collection);
  this.decreaseTokenBudgetBy(collection.getTokens());
}
```

Assigning beyond `length` creates **holes** (sparse array); `getChat()` iterates with `for…of`, sees `undefined`,
logs *"Skipping invalid or empty message"* and skips it. Later `add()` calls fill the holes, so the emission order
above is irrelevant to the final arrangement — only indices matter. `insert()/insertAtStart()/insertAtEnd()` locate
the bucket by identifier via `findMessageIndex()` (`:4249-4255`, throws `IdentifierNotFoundError`).

Relative extension prompts (`injectToMain`, `:1265-1284`): if the `main` collection exists, `insert(message, 'main',
position)` with `position = 'start' | 'end'`; otherwise the prompt is cloned, given `main`'s
role/injection_position/injection_depth/injection_order, and spliced into `absolutePrompts` immediately before/after
`main` so that it is injected in the same depth bucket.

**Edge case — disabled `main`.** `main` is exempt from the disabled check (`&& source !== 'main'`) and
`getPromptCollection()` substitutes an *empty placeholder* for it, so:

* disabled `main`, no character `system_prompt` ⇒ the bucket is added with `content: ''` and dropped by `getChat()`
  (no output), but the index still exists, so `injectToMain()` can place relative extension prompts "around main";
* disabled `main` **with** a character `system_prompt` override ⇒ the override replaces the empty content and *is*
  emitted. This is the one case where an entry disabled in `prompt_order` still produces output.

### 3.5 Step 4 — final flattening

```js
const chat = chatCompletion.getChat();          // openai.js:4120-4141
// per item: MessageCollection → item.getChat() (recursive), Message → {role, content, name?, tool_calls?,
//           tool_call_id? (role==='tool' only), signature?, reasoning?}
// Anything with falsy content and no tool_calls is dropped.
```

`MessageCollection.getChat()` (`:3832-3847`) is the same shape. `squashSystemMessages()` (only when
`oai_settings.squash_system_messages && !dryRun`, `:3922-3954`) flattens the tree and merges consecutive
`role === 'system'` messages **without a `name`**, joined with `'\n'`, except identifiers
`newMainChat`, `newChat`, `groupNudge`.

`openai_messages_count` = number of non-tool_calls messages with role in `['user','assistant','tool']` (`:1621`).

### 3.6 Step 5 — ABSOLUTE (in-chat) entries → depth injection

`populationInjectionPrompts(prompts, messages)` (`openai.js:810-875`). `messages` is **newest-first**, so
`injection_depth = 0` means "after the newest message". `maxDepth = getExtensionPromptMaxDepth()` =
`MAX_INJECTION_DEPTH` = **10000** (`script.js:500`; `getExtensionPromptMaxDepth()` returns it unconditionally at
`script.js:3281-3289`, with the depth-scanning optimisation commented out) — the loop really runs `i = 0 … 10000`;
use a map in a rewrite.

```js
let totalInsertedMessages = 0;
for (let i = 0; i <= maxDepth; i++) {
  const depthPrompts = prompts.filter(p => p.injection_depth === i && p.content);
  // group by injection_order (default 100), iterate orders DESCENDING: sort((a,b) => +b - +a)
  const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
  const roleMessages = [];                       // for this depth only
  for (const order of orders) {
    for (const role of ['system', 'user', 'assistant']) {         // fixed role precedence
      let rolePrompts = orderPrompts.filter(p => p.role === role).map(p => p.content).join('\n');
      const extensionPrompt = (order === '100')
          ? await getExtensionPrompt(IN_CHAT, i, '\n', roleTypes[role], false)   // wrap=false
          : '';
      const jointPrompt = [rolePrompts, extensionPrompt].filter(Boolean).map(s => s.trim()).join('\n');
      if (jointPrompt) roleMessages.push({ role, content: jointPrompt, injected: true });
    }
  }
  if (roleMessages.length) {
    messages.splice(i + totalInsertedMessages, 0, ...roleMessages);
    totalInsertedMessages += roleMessages.length;
  }
}
messages = messages.reverse();                   // ← in-place; array is now oldest-first
```

Notes: each depth produces **at most three** messages (one per role), all entries of that role at that depth being
joined with `\n`; `injected: true` is used later to find the last real message (§3.8). The extension-prompt fetch
`getExtensionPrompt(IN_CHAT, i, …)` merges third-party in-chat injections into the same bucket only for
`order === '100'`.

### 3.7 `chatHistory` and `dialogueExamples`

`populateChatHistory()` (`:885-1092`), added at `prompts.index('chatHistory')`:

1. Reserve budget for the "new chat" sentinel (`selected_group ? new_group_chat_prompt : new_chat_prompt`,
   macro-expanded, identifier `newMainChat`) and optionally `groupNudge`.
2. Reserve `continueNudge` collection when `type === 'continue'`, `cyclePrompt` set and `!oai_settings.continue_prefill`:
   the last non-injected message is removed from `messages`, prepared through the prompt manager, then the nudge
   (`continue_nudge_prompt` with `{{lastChatMessage}}`) is appended after it.
3. If the newest message is `assistant` and `send_if_empty` is set and affordable, insert
   `{role:'user', content: send_if_empty}` (identifier `emptyUserMessageReplacement`) after history.
4. Iterate `[...messages].reverse()` (newest → oldest) and `insertAtStart(message, 'chatHistory')` (chronological
   result); each message gets `identifier = chatHistory-<n>` and is produced by
   `Message.fromPromptAsync(promptManager.preparePrompt(prompt))`. Media inlining, tool calls, `signature`,
   `reasoning` attached here. Stops when `canAfford()` fails — this is the truncation point.
5. `insertAtStart(newChatMessage, 'chatHistory')` (so `[Start a new Chat]` is the first history message);
   `groupNudge` is `insertAtEnd`.

`populateDialogueExamples()` (`:1101-1134`), added at `prompts.index('dialogueExamples')`: for each example block,
insert `new_example_chat_prompt` (`[Example Chat]`) then every parsed example message (`role:'system'`,
`name: 'example_user' | 'example_assistant'`); abort when the whole block does not fit.

`power_user.pin_examples` swaps the order: examples before history if `true`, after if `false` (`:1337-1343`).

### 3.8 Control prompts and nudges

* `impersonate` (`type === 'impersonate'`) and `quietPrompt` are collected into `controlPrompts`, budget-reserved,
  then pushed **after everything else** (`chatCompletion.add(controlPrompts)`), preserving "quiet prompt is last".
* `continue` + `continue_prefill` (`:1320-1331`): the message to continue is `messages.shift()`ed, its content is
  prefixed with `assistant_prefill` for Claude (`\n\n` join), and appended to `controlPrompts` as
  `continuePrefill`; the continue nudge is *not* used in that mode.
* Tool-call budget is pre-reserved (`ToolManager.registerFunctionToolsOpenAI`), `+3` tokens are always reserved for
  the assistant priming (`:1210`).

### 3.9 Token budget

`chatCompletion.setTokenBudget(oai_settings.openai_max_context, oai_settings.openai_max_tokens)` ⇒ budget =
`context − max_tokens`; every `add/insert` checks and decrements, `reserveBudget()`/`freeBudget()` pre-reserve
optional groups. Failure throws `TokenBudgetExceededError`, surfaced as *"Not enough free tokens for mandatory
prompts"* (`:1589-1593`).

---

## 4. Markers, substitution, and world info

1. **Macro pass** happens twice per prompt: once in `getPromptCollection()` over the preset content and once in
   `preparePrompt()` over the merged runtime value, via `substituteParams(content, {original, groupOverride,
   name1Override, name2Override, ...})` (macro engine in `public/scripts/macros/`, `${original}` exposed so an
   override can embed the original text).
2. **World info**: `worldInfoBefore` / `worldInfoAfter` are already-assembled strings from `world-info.js`; the
   prompt layer only applies `formatWorldInfo()` = `wi_format` (`{0}` placeholder, default `"{0}"`) — no header, no
   separator. Depth WI entries are *not* part of these markers; they arrive as `extension_prompts`
   (`inject_ids.CUSTOM_WI_DEPTH_ROLE(depth, role)`), i.e. as in-chat injections (§3.6).
3. **Character fields** (`getCharacterCardFields()`, `script.js:3402-3490`): trimmed + macro-expanded; `description`,
   `personality`, `scenario`, `mesExamples` may be replaced by group cards; `scenario` prefers
   `chat_metadata.scenario`; `system` prefers `chat_metadata.system_prompt`, then
   `character.data.system_prompt`, and is `''` when `prefer_character_prompt` is false; `jailbreak` is
   `character.data.post_history_instructions` gated by `prefer_character_jailbreak`.
4. **`scenario_format` / `personality_format`** (oai preset, defaults `"{{scenario}}"` / `"{{personality}}"`):
   applied only when the field is non-empty — `substituteParams(oai_settings.scenario_format)` (`:1368-1369`).
   A user can therefore wrap them, e.g. `"Scenario: {{scenario}}"`.
5. **`names_behavior`** (oai preset, `character_names_behavior = { NONE:-1, DEFAULT:0, COMPLETION:1, CONTENT:2 }`,
   `openai.js:206-211`), applied per chat message in `setOpenAIMessages()`: `NONE` → never; `DEFAULT` → prefix
   `"<name>: "` for group/send-as/non-persona messages; `CONTENT` → prefix for every non-narrator message;
   `COMPLETION` → use the API's `name` field instead (`messages[].name`, sanitized by
   `promptManager.sanitizeName()`; Claude/Gemini converters inline it as `"name: content"`, §6.4).
6. **The exact Default context `story_string`** is quoted verbatim in §1.3 (JSON form and decoded form). It is a
   *text-completion* template and is not used by the marker pipeline above — in CC the equivalent of its
   `{{description}}/{{personality}}/{{scenario}}/{{persona}}/{{wiBefore}}/{{wiAfter}}` blocks are the individual
   markers `charDescription/charPersonality/scenario/personaDescription/worldInfoBefore/worldInfoAfter`.

---

## 5. Instruct mode template

### 5.1 Storage and application

* Folder `directories.instruct` (`data/<user>/instruct/`), shipped `default/content/presets/instruct/*.json`,
  `POST /api/presets/save {apiId:'instruct'}` (`presets.js:27-28`).
* Live settings object: `power_user.instruct` (`power-user.js:218-245`), plus `power_user.instruct.enabled`,
  `.preset` (selected name), `.bind_to_context`.
* Applying a preset (`instruct-mode.js:826-861`): `migrateInstructModeSettings(preset)` then, for each field in
  `controls`, `if (preset[prop] !== undefined) power_user.instruct[prop] = preset[prop]` — **fields missing from the
  file keep their current value** (unlike context templates, which fall back to a control default).
* Saving (`preset-manager.js:662-666`) clones the whole `power_user.instruct` and sets `name`, so a saved preset
  contains `enabled`/`preset` too; shipped presets usually omit them.
* Migrations (`instruct-mode.js:55-105`): `separator_sequence → output_suffix`; legacy `names`/`names_force_groups →
  names_behavior` (`always` / `force` / `none`); fills defaults for `input_suffix`, `system_sequence`,
  `system_suffix`, `user_alignment_message`, `last_system_sequence`, `first_input_sequence`, `last_input_sequence`,
  `skip_examples=false`, `system_same_as_user=false`, `names_behavior='force'`, `sequences_as_stop_strings=true`,
  `story_string_prefix=''`, `story_string_suffix=''`; deletes `system_sequence_prefix/suffix`.

### 5.2 Every field

Defaults = `power_user.instruct` (`power-user.js:218-245`) unless noted; `ChatML.json` values shown for reference.

| Field | Type | Default (power_user) | ChatML.json | Meaning |
| --- | --- | --- | --- | --- |
| `name` | string | — (preset name) | `"ChatML"` | Identifier of the template |
| `enabled` | boolean | `false` | — | Instruct mode on/off (not normally in preset files) |
| `preset` | string | `'Alpaca'` | — | Selected template name (not in preset files) |
| `system_prompt` | string | *(absent)* | *(absent)* | **Legacy migration hook, not a live field.** On save, `checkForSystemPromptInInstructTemplate()` (`sysprompt.js:76-99`) offers to copy a truthy `system_prompt` into a new `sysprompt` preset named `[Migrated] <template name>`, then deletes the key. Nothing at runtime reads it — the system prompt is the separate `sysprompt` preset (`power_user.sysprompt.content` / `.post_history`) |
| `input_sequence` | string | `'### Instruction:'` | `"<|im_start|>user"` | Prefix for user messages |
| `input_suffix` | string | `''` | `"<|im_end|>\n"` | Suffix after user content |
| `output_sequence` | string | `'### Response:'` | `"<|im_start|>assistant"` | Prefix for character messages |
| `output_suffix` | string | `''` | `"<|im_end|>\n"` | Suffix after character content (replaces deprecated `separator_sequence`) |
| `last_output_sequence` | string | `''` | `""` | Prefix for the **final** character turn (falls back to `output_sequence`) |
| `first_output_sequence` | string | `''` | `""` | Prefix for the **first** example character turn |
| `first_input_sequence` | string | `''` | `""` | Prefix for the first user turn |
| `last_input_sequence` | string | `''` | `""` | Prefix for the last user turn / impersonation |
| `system_sequence` | string | `''` | `"<|im_start|>system"` | Prefix for narrator/system messages |
| `system_suffix` | string | `''` | `"<|im_end|>\n"` | Suffix for system messages |
| `last_system_sequence` | string | `''` | `""` | System prefix for quiet generations |
| `story_string_prefix` | string | `''` | `"<|im_start|>system"` | Prepended to the rendered story string (TC only) |
| `story_string_suffix` | string | `''` | `"<|im_end|>\n"` | Appended to the rendered story string (TC only) |
| `stop_sequence` | string | `''` | `"<|im_end|>"` | Extra stop string |
| `wrap` | boolean | `true` | `true` | `\n` becomes the separator between sequence and text, and is added as a stop-string prefix |
| `macro` | boolean | `true` | `true` | Run `substituteParams` + `{{name}}` replacement on sequences |
| `names_behavior` | `'none'\|'force'\|'always'` | `'force'` | `"force"` | `always` = always prefix `"Name: "`; `force` = only for group/send-as and the persona side of examples |
| `activation_regex` | string | `''` | `""` | Regex tested against the model id to auto-select this template (`instruct-mode.js:262-277`) |
| `bind_to_context` | boolean | `false` | *(absent → keeps value)* | Selecting a context template auto-selects the instruct template with the same name and vice versa |
| `skip_examples` | boolean | `false` | `false` | Emit example blocks verbatim (only `<START>` → separator) instead of applying sequences |
| `user_alignment_message` | string | `''` | `""` | Extra first "user" message injected before the history (`script.js:4818-4828`) |
| `system_same_as_user` | boolean | `false` | `false` | Narrator/system messages use `input_sequence`/`input_suffix` instead of system ones |
| `sequences_as_stop_strings` | boolean | `true` | `true` | Add all sequences to the stop list |
| `separator_sequence` | string | `''` (deprecated) | — | Migrated to `output_suffix` |

### 5.3 Formatting functions (text completion)

`formatInstructModeChat(name, mes, isUser, isNarrator, forceAvatar, name1, name2, forceOutputSequence, custom)` (`:387-457`):

```
prefix = narrator ? (system_same_as_user ? input_sequence : system_sequence)
       : isUser   ? (FIRST→first_input_sequence||input_sequence, LAST→last_input_sequence||input_sequence, else input_sequence)
                  : (FIRST→first_output_sequence||output_sequence, LAST→last_output_sequence||output_sequence, else output_sequence)
suffix = narrator ? (system_same_as_user ? input_suffix : system_suffix) : isUser ? input_suffix : output_suffix
if (macro) { prefix = substituteParams(prefix, {name1Override, name2Override}).replace(/{{name}}/gi, name || 'System'); … }
if (!suffix && wrap) suffix = '\n'
separator = wrap ? '\n' : ''
text = [prefix, includeNames && name ? `${name}: ${mes}${suffix}` : `${mes}${suffix}`].filter(Boolean).join(separator)
```

`formatInstructModePrompt()` (`:593-651`) builds the trailing assistant cue (`last_output_sequence || output_sequence`,
`last_system_sequence` for quiet, `last_input_sequence` for impersonation, `"Name:"` when names are included,
`wrap ? text.trimEnd() : text`).

`formatInstructModeExamples()` (`:511-579`) applies `input_*`/`output_*` to each parsed example, prefixes the block
with `example_separator + '\n'`, and honours `skip_examples`.

`formatInstructModeStoryString()` (`:478-502`): only when `story_string_position !== IN_CHAT`, prepend
`substituteParams(story_string_prefix).replace(/{{name}}/gi,'System') + (wrap?'\n':'')` and append
`substituteParams(story_string_suffix)`. `formatInstructModeSystemPrompt()` is a deprecated no-op (`:466-468`).

### 5.4 Stop sequences

`getInstructStoppingSequences({customInstruct, useStopStrings})` (`:301-367`):

1. If instruct enabled: `stop_sequence`, plus — when `sequences_as_stop_strings` — `input_sequence`,
   `output_sequence`, `first_output_sequence`, `last_output_sequence`, `system_sequence`, `last_system_sequence`
   (each with `{{name}}` → `name1` / `name2` / `'System'`), joined by `\n`, split, deduplicated.
2. Each candidate: skip if empty/whitespace-only; `wrap` ⇒ prefix `\n`; `macro` ⇒ `substituteParams`.
3. If `useStopStrings ?? power_user.context.use_stop_strings`: push `'\n' + substituteParams(chat_start)` and
   `'\n' + substituteParams(example_separator)`.

`getStoppingStrings(isImpersonate, isContinue, api)` (`script.js:3025-3066`): for `api === 'openai'` it returns **only**
`getCustomStoppingStrings()`; otherwise `names_as_stop_strings` stops (`\n<char>:`, `\n<user>:`, group members,
`single_line` ⇒ `\n`) + instruct sequences + custom strings, deduplicated, falsy removed.

### 5.5 Model→template binding

`autoSelectInstructPreset(modelId)` (`:236-292`): (1) `power_user.model_templates_mappings[modelId]` (or
`[chat_template_hash]`) `{instruct, context}` wins; (2) else, first instruct preset whose `activation_regex` matches;
(3) else, if `bind_to_context`, the instruct preset whose `name === power_user.context.preset`;
(4) `selectMatchingContextTemplate(name)` runs the reverse lookup (`:657-665`).

### 5.6 Chat completion interaction

`openai.js` never reads `power_user.instruct` (grep-verified). Instruct mode is a **text-completion-only** feature in
1.19.0; for CC the equivalent behaviour is `names_behavior` inside the chat completion preset plus `prefill`
(`assistant_prefill` / `assistant_impersonation`), not the instruct sequences.

---

## 6. Sampler settings in a chat completion preset

### 6.1 Two key spaces

The preset file uses *public* names; the in-memory `oai_settings` uses `*_openai` names. The mapping is
`settingsToUpdate` (`openai.js:305-409`, `preset_name -> [selector, setting_name, is_checkbox, is_connection]`), and
`getChatCompletionPreset()` (`:4582-4588`) serializes **every** key of it, which is why the shipped preset has ~60
keys even though only a fraction are samplers.

| Preset key | `oai_settings` key | Default | Sent to API as |
| --- | --- | --- | --- |
| `temperature` | `temp_openai` | `1.0` | `temperature` |
| `frequency_penalty` | `freq_pen_openai` | `0` | `frequency_penalty` |
| `presence_penalty` | `pres_pen_openai` | `0` | `presence_penalty` |
| `top_p` | `top_p_openai` | `1` | `top_p` |
| `top_k` | `top_k_openai` | `0` | `top_k` (Claude, OpenRouter, MakerSuite/VertexAI, Cohere, Perplexity, ElectronHub, Chutes, Workers AI, NanoGPT, MiniMax…) |
| `top_a` | `top_a_openai` | `0` | `top_a` (OpenRouter, NanoGPT) |
| `min_p` | `min_p_openai` | `0` | `min_p` (OpenRouter, Chutes, NanoGPT) |
| `repetition_penalty` | `repetition_penalty_openai` | `1` | `repetition_penalty` (OpenRouter, Chutes, NanoGPT, Workers AI) |
| `openai_max_context` | `openai_max_context` | `4095` (`max_4k`) | not sent — token budget only |
| `openai_max_tokens` | `openai_max_tokens` | `300` | `max_tokens` (→ `max_completion_tokens` for o1/o3/o4, gpt-5*, gpt-6-astra) |
| `seed` | `seed` | `-1` | `seed` when source supports it and `seed >= 0` |
| `n` | `n` | `1` | `n` (multi-swipe, only for OpenAI/Azure/Custom/xAI/Aimlapi/Moonshot, and not for `quiet`/`impersonate`/`continue`) |
| `stream_openai` | `stream_openai` | `true` in preset / `false` in `default_settings` | `stream` (forced `false` for `type==='quiet'`, `o1`, Workers-AI+json-schema) |
| `chat_completion_source` | `chat_completion_source` | `'openai'` | `chat_completion_source` (server dispatch) |
| `openai_model`, `claude_model`, … | same | per source | `model` via `getChatCompletionModel()` |
| `names_behavior` | `names_behavior` | `0` | not sent (affects message building, §4.5) |
| `wi_format`, `scenario_format`, `personality_format` | same | `"{0}"`, `"{{scenario}}"`, `"{{personality}}"` | not sent (prompt text) |
| `send_if_empty`, `impersonation_prompt`, `new_chat_prompt`, `new_group_chat_prompt`, `new_example_chat_prompt`, `continue_nudge_prompt`, `group_nudge_prompt` | same | see `default_settings` (`:426-437`) | not sent (prompt text) |
| `use_sysprompt` | `use_sysprompt` | `false` | `use_sysprompt` (Claude/MakerSuite/VertexAI) |
| `assistant_prefill`, `assistant_impersonation` | same | `''` | `assistant_prefill` (Claude) |
| `squash_system_messages` | same | `false` | not sent (merging) |
| `continue_prefill`, `continue_postfix` | same | `false`, `' '` | client-side continuation behaviour |
| `media_inlining` | same | `true` | client-side |
| `bias_preset_selected` + `bias_presets` | same | `'Default (none)'` | `logit_bias` object built from the selected preset |
| `reverse_proxy`, `proxy_password`, `custom_*`, provider-specific keys | same | — | forwarded per source |
| `prompts`, `prompt_order` | same | §2 | not sent (assembly) |
| `extensions` | `extensions` | `{}` | not sent (applied by `onSettingsPresetChange` only) |

### 6.2 Request body

`sendOpenAIRequest()` → `createGenerationParameters()` (`openai.js:2691-3127`) builds:

```js
{
  type, messages, model,
  temperature: Number(temp_openai),
  frequency_penalty: Number(freq_pen_openai),
  presence_penalty: Number(pres_pen_openai),
  top_p: Number(top_p_openai),
  max_tokens: openai_max_tokens,
  stream, logit_bias, stop: getCustomStoppingStrings(openai_max_stop_strings),
  chat_completion_source, n, user_name: name1, char_name: name2, group_names,
  include_reasoning: Boolean(show_thoughts), reasoning_effort, enable_web_search,
  request_images, request_image_resolution, request_image_aspect_ratio,
  custom_prompt_post_processing, verbosity
}
```

then POSTs to `/api/backends/chat-completions/generate` (`:3148-3154`). `stop` is deleted when empty; `logit_bias`
is `undefined` unless a bias preset with entries is selected; `seed` is added only for
`seedSupportedSources` when `seed >= 0`. Stop strings come from `getCustomStoppingStrings(openai_max_stop_strings)`
with `openai_max_stop_strings = 4` (`:144`) — i.e. **at most 4 custom stop strings** by default for OpenAI-like
sources; the per-source branches listed below override both the limit and the `stop` array.

Per-source additions / deletions (same function): OpenRouter (`top_k`, `min_p`, `repetition_penalty`, `top_a`,
provider/quantization/fallback options), Claude (`top_k`, `use_sysprompt`, unlimited `stop`, `assistant_prefill`),
MakerSuite/VertexAI (`top_k`, ≤5 stop strings of 1–16 chars, `use_sysprompt`, Vertex auth/region), Mistral
(unlimited `stop`, `safe_prompt:false`), Cohere (clamps `top_p` 0.01–0.99 and penalties 0–1, 5 stops), Perplexity
(no `stop`), Groq (no logprobs/logit_bias/n), DeepSeek (`top_p || ε`), xAI (drops penalties/stop for some models,
`reasoning_effort` only for `grok-3-mini`), Z.AI (`top_p || 0.01`, 1 stop, no penalties), MiniMax (temperature
clamped to `(0,1]`), Workers AI (`top_k ≤ 50`, seed, no `n`), NanoGPT (samplers), Moonshot (`kimi-k2.5` drops
sampling), Chutes/ElectronHub (samplers). Model-based stripping: `o1/o3/o4` (drops temperature/top_p/penalties/stop,
renames to `max_completion_tokens`, system→user), `gpt-5*`, `gpt-6-astra`, and
`/claude-(fable|opus-5|sonnet-5)/` (drops temperature/top_p/top_k/penalties).

### 6.3 Server-side transform (relevant to presets)

`src/endpoints/backends/chat-completions.js` + `src/prompt-converters.js` convert the uniform `messages[]`:

* Claude (`convertClaudeMessages`, `prompt-converters.js:197-330`): if `use_sysprompt`, **all leading** `system`
  messages are collected into the top-level `system` array and spliced out; remaining `system` messages become
  `user`; `name` is inlined as `"name: content"`; empty text → `\u200b`; last `assistant` message becomes the
  prefill (`assistant_prefill`).
* Gemini (`convertGooglePrompt`, `:432+`): same idea → `systemInstruction` when `use_sysprompt`.

This is why `squash_system_messages` and the marker ordering matter: consecutive system messages are what the
Claude/Gemini converters hoist.

---

## 7. Which parts belong to which file, and how they link

### 7.1 File ownership

| Concern | Chat completion preset (`presets/openai/*.json`) | Context template (`presets/context/*.json`) | Instruct template (`presets/instruct/*.json`) |
| --- | --- | --- | --- |
| Samplers, `max_context`, `max_tokens`, `stream`, `seed`, `n` | ✅ | — | — |
| Connection/source, model ids, proxy, provider options | ✅ | — | — |
| `prompts[]` + `prompt_order[]` (the prompt manager) | ✅ | — | — |
| Behaviour strings (`send_if_empty`, `impersonation_prompt`, `new_chat_prompt`, `continue_nudge_prompt`, `group_nudge_prompt`, `new_example_chat_prompt`) | ✅ | — | — |
| Formats (`wi_format`, `scenario_format`, `personality_format`), `names_behavior`, `squash_system_messages`, `use_sysprompt`, `assistant_prefill` | ✅ | — | — |
| `story_string`, `example_separator`, `chat_start` | — | ✅ | — |
| `use_stop_strings`, `names_as_stop_strings`, `story_string_position/depth/role` | — | ✅ | — |
| `always_force_name2`, `trim_sentences`, `single_line` | — | ✅ (stored, but they are global `power_user` flags) | — |
| `input/output/system/first/last_*_sequence`, `*_suffix`, `story_string_prefix/suffix` | — | — | ✅ |
| `wrap`, `macro`, `names_behavior`(instruct), `skip_examples`, `activation_regex`, `bind_to_context`, `user_alignment_message`, `system_same_as_user`, `sequences_as_stop_strings`, `stop_sequence` | — | — | ✅ |
| System prompt text | — | — | — (separate `presets/sysprompt/*.json`: `{name, content, post_history}`) |

### 7.2 On-disk layout (defaults → user)

```
default/content/presets/openai/Default.json   → data/<user>/OpenAI Settings/Default.json
default/content/presets/context/Default.json  → data/<user>/context/Default.json
default/content/presets/instruct/ChatML.json  → data/<user>/instruct/ChatML.json
default/content/presets/sysprompt/*.json      → data/<user>/sysprompt/*.json
```

`apiId` → folder (`presets.js:16-38`): `openai`→`openAI_Settings`, `context`→`context`, `instruct`→`instruct`,
`sysprompt`→`sysprompt`, `reasoning`→`reasoning`, `textgenerationwebui`→`textGen_Settings`,
`kobold|koboldhorde`→`koboldAI_Settings`, `novel`→`novelAI_Settings`. Extension `.json` for all.

### 7.3 Runtime links between the three

1. **Selection only** — `power_user.context.preset` (context name), `power_user.instruct.preset` +
   `power_user.instruct.enabled` (instruct), `oai_settings.preset_settings_openai` (CC). Independent variables.
2. **`bind_to_context`** (`power_user.instruct.bind_to_context`, stored in the instruct template, default `false`):
   selecting an instruct template with the same name selects that context template and vice versa
   (`instruct-mode.js:855-858`, `:657-665`, `power-user.js:2076+`); enabling instruct mode also selects the matching
   context template (`:808-816`).
3. **`activation_regex`** — auto-select an instruct template from the model id; `model_templates_mappings`
   (`{modelId|chatTemplateHash: {instruct, context}}`) overrides it (`:236-292`).
4. **Name convention** — `AutoComplete` of templates depends on identical names across folders (`ChatML.json` exists
   in both `context/` and `instruct/`), but nothing enforces it.
5. **Chat completion preset ↔ context/instruct: no link in the prompt pipeline.** CC uses only its own `prompts` +
   `prompt_order` and its own `names_behavior`/format strings. The only cross-effect is a UI one: the same prompt
   manager object (`promptManager`) is bound to `oai_settings` as its `serviceSettings` (`openai.js:675-721`).
6. **Sysprompt** is a fourth, independent file used for TC APIs; for CC the same text usually arrives through the
   character card's `system_prompt` field (`systemPromptOverride` → `main`).
7. **Master import/export** (`preset-manager.js:117-207`, `:244-380`) bundles the sections under keys
   `instruct`, `context`, `sysprompt`, `preset`, `reasoning`, `srw`, detected by required-key probes
   (`isPossiblyInstructData` = `name,input_sequence,output_sequence`; `isPossiblyContextData` = `name,story_string`;
   `isPossiblySystemPromptData` = `name,content`; `isPossiblyTextCompletionData` = `temp,top_k,top_p,rep_pen`).

---

## 8. Open questions / unverified edges

1. **`{{charIfNotGroup}}`** appears in the built-in default main prompt (`PromptManager.js:2007`) while the shipped
   `Default.json` uses `{{char}}`. Both are defined by the macro engine; the exact group-chat expansion
   (`{{char}}` = generating member; `{{charIfNotGroup}}` = `''` in groups) was not verified against
   `public/scripts/macros/definitions/`.
2. **`system_prompt` in instruct templates** — confirmed to be a save-time migration hook only (`sysprompt.js:76-99`),
   but it was not verified whether the popup fires for every import path (e.g. master import calls
   `savePreset()` before `checkForSystemPromptInInstructTemplate`, which is the only caller path observed).
3. **Hole semantics** — `ChatCompletion.add()` writing at an index beyond `length` relies on sparse-array holes being
   skipped by `for…of` + `instanceof` checks. Porting to TypeScript with a dense array would silently insert
   `undefined` entries; a rewrite should use an explicit `Map<index, bucket>` or pre-fill with `null`.
4. **`injection_order` collision with extension prompts** — third-party IN_CHAT prompts are merged only into the
   `order === '100'` bucket. Whether an absolute prompt with `injection_order` set to something other than `100` can
   ever be joined by an extension prompt was not tested; the code implies no.
5. **10001-iteration loop** in `populationInjectionPrompts` — correctness is clear, but the performance implication
   for large presets (and whether upstream intends to restore the max-depth optimisation that is commented out in
   `getExtensionPromptMaxDepth()`) is a design question, not a documented one.
6. **`enabled` for extension-generated prompts** — `isPromptDisabledForActiveCharacter()` returns `false` when the
   identifier has no `prompt_order` entry, so extension prompts cannot be disabled; intended or not, unverified.
7. **Exact `default_settings` drift** — `default_settings.stream_openai` is `false` (`openai.js:421`) while the
   shipped `Default.json` sets `true`; a fresh install therefore streams only after a preset is applied. Not a bug
   per se, but a re-implementation needs to decide which is the "default".
8. **`substituteParams` ordering inside `preparePrompt`** — `{{original}}` is only available when an override exists;
   the interaction of `original` with `groupOverride` (both passed simultaneously in group chats,
   `PromptManager.js:1282`) was not exercised.
9. **`prompt_order` for `character_id` 100000 vs 100001** — only 100001 is read by the CC manager; why shipped
   presets still carry 100000 (backwards compatibility with per-character prompt orders written before 1.12?) is not
   documented in source.

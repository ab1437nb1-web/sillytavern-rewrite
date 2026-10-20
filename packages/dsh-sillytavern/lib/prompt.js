/**
 * Chat-completion preset model and prompt assembly.
 *
 * A SillyTavern preset is one JSON document holding two different things: the
 * prompt manager (ordered, toggleable prompt entries) and the sampler settings.
 * DSH already owns the conversation, so assembly here reproduces only the
 * system-side half of `prepareOpenAIChatCompletion`: every enabled entry that
 * resolves to text is emitted in `prompt_order`, `main`/`jailbreak` accept the
 * character card's overrides, and world-info buckets land on their markers.
 *
 * Deliberate deviations (documented for the user):
 *  - `chatHistory` is DSH's own message list and is never rebuilt here.
 *  - ABSOLUTE (in-chat) entries are returned as `depth` injections instead of
 *    being spliced into history; the caller decides where they can go.
 */

export const DEFAULT_MAIN_PROMPT = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}."
export const DEFAULT_ENHANCE_DEFINITIONS =
  "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute."
export const DEFAULT_NEW_EXAMPLE_CHAT = '[Example Chat]'

export const BUILTIN_PROMPTS = [
  { identifier: 'main', name: 'Main Prompt', role: 'system', system_prompt: true, content: DEFAULT_MAIN_PROMPT },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'system', system_prompt: true, marker: true },
  { identifier: 'personaDescription', name: 'Persona Description', role: 'system', system_prompt: true, marker: true },
  { identifier: 'charDescription', name: 'Char Description', role: 'system', system_prompt: true, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', role: 'system', system_prompt: true, marker: true },
  { identifier: 'scenario', name: 'Scenario', role: 'system', system_prompt: true, marker: true },
  { identifier: 'enhanceDefinitions', name: 'Enhance Definitions', role: 'system', system_prompt: true, content: DEFAULT_ENHANCE_DEFINITIONS },
  { identifier: 'nsfw', name: 'Auxiliary Prompt', role: 'system', system_prompt: true, content: '' },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', role: 'system', system_prompt: true, marker: true },
  { identifier: 'dialogueExamples', name: 'Chat Examples', role: 'system', system_prompt: true, marker: true },
  { identifier: 'chatHistory', name: 'Chat History', role: 'system', system_prompt: true, marker: true },
  { identifier: 'jailbreak', name: 'Post-History Instructions', role: 'system', system_prompt: true, content: '' },
]

export const DEFAULT_PROMPT_ORDER = [
  'main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario',
  'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak',
]

const ORDER_BLOCK_IDS = ['100001', '100000']

function pickPromptOrder(raw) {
  const lists = Array.isArray(raw?.prompt_order) ? raw.prompt_order : []
  for (const id of ORDER_BLOCK_IDS) {
    const block = lists.find((list) => String(list?.character_id) === id)
    if (block?.order?.length) return block.order
  }
  const fromList = lists.find((list) => list?.order?.length)?.order
  if (fromList) return fromList
  // An already-normalized preset (the stored document) carries the camelCase
  // key; normalizing is idempotent so both shapes are accepted.
  if (Array.isArray(raw?.promptOrder) && raw.promptOrder.length) return raw.promptOrder
  return null
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Normalizes any SillyTavern chat-completion preset (or a bare prompt list). */
export function normalizePreset(raw, name) {
  const prompts = Array.isArray(raw?.prompts) && raw.prompts.length
    ? raw.prompts.map((prompt) => ({
      identifier: asString(prompt.identifier, asString(prompt.name)),
      name: asString(prompt.name, asString(prompt.identifier)),
      role: ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system',
      system_prompt: prompt.system_prompt ?? false,
      content: asString(prompt.content),
      injection_position: Number(prompt.injection_position ?? 0) === 1 ? 1 : 0,
      injection_depth: Number(prompt.injection_depth ?? 4),
      injection_order: Number(prompt.injection_order ?? 100),
      forbid_overrides: prompt.forbid_overrides ?? false,
      marker: prompt.marker ?? false,
      enabled: prompt.enabled !== false,
    }))
    : BUILTIN_PROMPTS.map((prompt) => ({ ...prompt, injection_position: 0, injection_depth: 4, injection_order: 100, forbid_overrides: false, enabled: true }))

  const orderList = pickPromptOrder(raw)
  const promptOrder = orderList
    ? orderList.map((entry) => ({
      identifier: asString(entry.identifier, asString(entry.id)),
      enabled: entry.enabled !== false,
    }))
    : DEFAULT_PROMPT_ORDER.map((identifier) => ({ identifier, enabled: true }))

  // Identifiers present in the preset but missing from the order are appended,
  // mirroring PromptManager.checkForMissingPrompts().
  const known = new Set(promptOrder.map((entry) => entry.identifier))
  for (const prompt of prompts) {
    if (!known.has(prompt.identifier)) {
      promptOrder.push({ identifier: prompt.identifier, enabled: true })
    }
  }

  return {
    name: asString(raw?.name, name),
    prompts,
    promptOrder,
    temperature: Number(raw?.temperature ?? 1),
    frequencyPenalty: Number(raw?.frequency_penalty ?? raw?.frequencyPenalty ?? 0),
    presencePenalty: Number(raw?.presence_penalty ?? raw?.presencePenalty ?? 0),
    topP: Number(raw?.top_p ?? raw?.topP ?? 1),
    topK: Number(raw?.top_k ?? raw?.topK ?? 0),
    repetitionPenalty: Number(raw?.repetition_penalty ?? raw?.repetitionPenalty ?? 1),
    maxTokens: Number(raw?.openai_max_tokens ?? raw?.maxTokens ?? 0) || null,
    maxContext: Number(raw?.openai_max_context ?? raw?.maxContext ?? 0) || null,
    stop: Array.isArray(raw?.stop) ? raw.stop.filter((value) => typeof value === 'string') : [],
    wiFormat: asString(raw?.wi_format ?? raw?.wiFormat, '{0}'),
    scenarioFormat: asString(raw?.scenario_format ?? raw?.scenarioFormat, '{{scenario}}'),
    personalityFormat: asString(raw?.personality_format ?? raw?.personalityFormat, '{{personality}}'),
    newExampleChatPrompt: asString(raw?.new_example_chat_prompt ?? raw?.newExampleChatPrompt, DEFAULT_NEW_EXAMPLE_CHAT),
    newChatPrompt: asString(raw?.new_chat_prompt ?? raw?.newChatPrompt, '[Start a new Chat]'),
    squashSystemMessages: raw?.squash_system_messages ?? raw?.squashSystemMessages ?? true,
    context: {
      storyString: asString(raw?.context?.story_string),
      exampleSeparator: asString(raw?.context?.example_separator, '***'),
      chatStart: asString(raw?.context?.chat_start, '***'),
    },
  }
}

function applyFormat(template, value, macros) {
  if (!value) return ''
  if (!template) return substituteMacros(value, macros)
  return substituteMacros(template.split('{{personality}}').join(value).split('{{scenario}}').join(value), macros)
}

export function substituteMacros(text, macros) {
  if (!text || typeof text !== 'string') return ''
  let out = text
  for (const [name, value] of Object.entries(macros)) {
    if (value === undefined || value === null) continue
    out = out.split(`{{${name}}}`).join(String(value))
  }
  return out
}

/**
 * Splits `mes_example` into the blocks SillyTavern emits for chat completion:
 * each `<START>`-delimited section becomes `[Example Chat]\n<block>`.
 */
export function formatExamples(mesExample, newExampleChatPrompt = DEFAULT_NEW_EXAMPLE_CHAT) {
  if (!mesExample || mesExample === '<START>') return ''
  const source = mesExample.startsWith('<START>') ? mesExample : `<START>\n${mesExample.trim()}`
  const blocks = source.split(/<START>/gi).slice(1).map((block) => block.trim()).filter(Boolean)
  return blocks
    .map((block) => `${newExampleChatPrompt}\n${block.replace(/<START>/gi, '{Example Dialogue:}')}`)
    .join('\n')
}

function promptByIdentifier(preset, identifier) {
  return preset.prompts.find((prompt) => prompt.identifier === identifier) ?? null
}

function resolveEntry(identifier, { preset, character, worldInfo, persona, macros }) {
  switch (identifier) {
    case 'main': {
      const base = promptByIdentifier(preset, 'main')
      if (!base) return { role: 'system', text: '' }
      const override = character?.systemPrompt?.trim()
      const blocked = base.forbid_overrides === true
      return { role: 'system', text: substituteMacros(blocked ? base.content : (override || base.content), macros) }
    }
    case 'worldInfoBefore':
      return { role: 'system', text: wrapWorldInfo(worldInfo?.before ?? '', preset.wiFormat, macros) }
    case 'worldInfoAfter':
      return { role: 'system', text: wrapWorldInfo(worldInfo?.after ?? '', preset.wiFormat, macros) }
    case 'charDescription':
      return { role: 'system', text: substituteMacros(character?.description ?? '', macros) }
    case 'charPersonality':
      return { role: 'system', text: applyFormat(preset.personalityFormat, character?.personality ?? '', macros) }
    case 'scenario':
      return { role: 'system', text: applyFormat(preset.scenarioFormat, character?.scenario ?? '', macros) }
    case 'personaDescription':
      return { role: 'system', text: persona?.description ?? '' }
    case 'dialogueExamples':
      return { role: 'system', text: formatExamples(character?.mesExample ?? '', preset.newExampleChatPrompt) }
    case 'jailbreak': {
      const base = promptByIdentifier(preset, 'jailbreak')
      const override = character?.postHistoryInstructions?.trim()
      const blocked = base?.forbid_overrides === true
      return { role: 'system', text: substituteMacros(blocked ? (base?.content ?? '') : (override || base?.content || ''), macros) }
    }
    case 'nsfw': {
      const prompt = promptByIdentifier(preset, 'nsfw')
      return { role: 'system', text: substituteMacros(prompt?.content ?? '', macros) }
    }
    case 'enhanceDefinitions': {
      const prompt = promptByIdentifier(preset, 'enhanceDefinitions')
      return { role: 'system', text: prompt ? substituteMacros(prompt.content || DEFAULT_ENHANCE_DEFINITIONS, macros) : '' }
    }
    case 'chatHistory':
      return { role: 'system', text: '', skip: true }
    default: {
      const prompt = promptByIdentifier(preset, identifier)
      if (!prompt) return { role: 'system', text: '' }
      return {
        role: prompt.role,
        text: substituteMacros(prompt.content, macros),
        absolute: prompt.injection_position === 1
          ? { depth: prompt.injection_depth, order: prompt.injection_order }
          : null,
      }
    }
  }
}

function wrapWorldInfo(value, wiFormat, macros) {
  if (!value) return ''
  const text = substituteMacros(value, macros)
  if (!wiFormat || wiFormat === '{0}') return text
  return wiFormat.split('{0}').join(text)
}

/**
 * Produces the system text for one turn.
 *
 * @returns {{ text: string, depth: Array<{depth: number, role: string, text: string}> }}
 */
export function buildPromptText({ preset, character, worldInfo, persona = {}, macros = {} }) {
  const allMacros = {
    char: character?.name ?? '',
    user: persona.name ?? 'User',
    persona: persona.name ?? 'User',
    original: '',
    ...macros,
  }
  const parts = []
  const depth = []
  const disabled = new Map(preset.promptOrder.map((entry) => [entry.identifier, entry.enabled]))
  const orderedIdentifiers = preset.promptOrder.map((entry) => entry.identifier)

  for (const identifier of orderedIdentifiers) {
    if (disabled.get(identifier) === false) continue
    const resolved = resolveEntry(identifier, { preset, character, worldInfo, persona, macros: allMacros })
    if (!resolved || !resolved.text) continue
    if (resolved.absolute) {
      depth.push({ depth: resolved.absolute.depth, order: resolved.absolute.order, role: resolved.role, text: resolved.text })
      continue
    }
    if (resolved.skip) continue
    parts.push({ role: resolved.role, text: resolved.text })
  }

  // Prompts the preset defines that the order never mentions were appended to
  // the order by normalizePreset, so every enabled entry is visited above.

  // Adjacent system fragments are concatenated, like squashSystemMessages().
  const squash = preset.squashSystemMessages !== false
  const merged = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (squash && last && last.role === 'system' && part.role === 'system') {
      last.text = `${last.text}\n${part.text}`
    } else {
      merged.push({ ...part })
    }
  }

  return { text: merged.map((part) => part.text.trim()).filter(Boolean).join('\n\n'), depth }
}

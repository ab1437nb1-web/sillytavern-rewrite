/**
 * World Info (lorebook) activation engine — a dependency-free port of
 * SillyTavern 1.19's `checkWorldInfo` (public/scripts/world-info.js).
 *
 * Faithful where fidelity is observable: the entry model and its `??` defaults,
 * the `\n\x01` scan buffer, regex/whole-word/case matching, the four selective
 * logics, constant/sticky/cooldown/delay, probability, recursion passes with
 * `preventRecursion`/`excludeRecursion`/`delayUntilRecursion`, inclusion groups,
 * the percentage-of-context token budget, and the position buckets joined with
 * `\n`.
 *
 * Deliberate deviations, both documented in `research/worldinfo.md`:
 *  - `characterFilter` (per-character include/exclude filters) is not applied;
 *    the library binds books to a session explicitly instead.
 *  - Author's-Note and outlet buckets are returned separately rather than
 *    merged into another subsystem, because DSH has no Author's Note.
 */

import { estimateTokens } from './tokens.js'

export const POSITION = {
  before: 0,
  after: 1,
  anTop: 2,
  anBottom: 3,
  atDepth: 4,
  emTop: 5,
  emBottom: 6,
  outlet: 7,
}

export const SELECTIVE_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
}

export const ROLE = { system: 0, user: 1, assistant: 2 }

const DEFAULT_DEPTH = 4
const DEFAULT_ORDER = 100
const DEFAULT_WEIGHT = 100
const MAX_SCAN_DEPTH = 1000
const MATCHER = '\x01'
const JOINER = `\n${MATCHER}`

const SCAN = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 }

// ---- text helpers ---------------------------------------------------------

const REGEX_KEYS = /^\/([\w\W]+?)\/([gimsuy]*)$/

export function parseRegexFromString(input) {
  if (typeof input !== 'string') return null
  const match = input.match(REGEX_KEYS)
  if (!match) return null
  if (match[1].match(/(^|[^\\])\//)) return null
  const pattern = match[1].replace('\\/', '/')
  try {
    return new RegExp(pattern, match[2])
  } catch {
    return null
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function substituteParams(text, macros = {}) {
  if (!text) return ''
  let out = text
  for (const [name, value] of Object.entries(macros)) {
    if (value === undefined || value === null) continue
    out = out.split(`{{${name}}}`).join(String(value))
  }
  return out
}

/** FNV-1a over the entry's identity: edits invalidate running timed effects. */
export function hashEntry(entry) {
  const source = JSON.stringify({
    key: entry.key,
    keysecondary: entry.keysecondary,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    order: entry.order,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ---- entry model ----------------------------------------------------------

const CARD_POSITIONS = {
  before_char: 0,
  after_char: 1,
  before_an: 2,
  after_an: 3,
  at_depth: 4,
  before_em: 5,
  after_em: 6,
  outlet: 7,
}

/**
 * Maps one entry from either shape into SillyTavern's runtime field names:
 *  - world-info files and the editor use `key`/`keysecondary`/`order`/`position`
 *    (numbers) with per-entry overrides as `null`;
 *  - character-card `character_book` entries use `keys`/`secondary_keys`/
 *    `insertion_order`/`position` (strings) and put overrides under
 *    `extensions` with snake_case keys.
 */
function mapEntryShape(raw) {
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  const pick = (a, b, fallback) => raw[a] ?? ext[b] ?? fallback
  const position = typeof raw.position === 'number'
    ? raw.position
    : (typeof ext.position === 'number' ? ext.position : CARD_POSITIONS[raw.position] ?? 0)

  return {
    key: Array.isArray(raw.key) ? raw.key : (Array.isArray(raw.keys) ? raw.keys : []),
    keysecondary: Array.isArray(raw.keysecondary)
      ? raw.keysecondary
      : (Array.isArray(raw.secondary_keys) ? raw.secondary_keys : []),
    comment: raw.comment ?? '',
    content: raw.content ?? '',
    constant: raw.constant ?? false,
    vectorized: pick('vectorized', 'vectorized', false),
    selective: raw.selective ?? true,
    selectiveLogic: pick('selectiveLogic', 'selectiveLogic', 0),
    addMemo: raw.addMemo ?? false,
    order: raw.order ?? raw.insertion_order ?? 100,
    position,
    disable: raw.disable ?? (raw.enabled === false ? true : false),
    ignoreBudget: pick('ignoreBudget', 'ignore_budget', false),
    excludeRecursion: pick('excludeRecursion', 'exclude_recursion', false),
    preventRecursion: pick('preventRecursion', 'prevent_recursion', false),
    matchPersonaDescription: pick('matchPersonaDescription', 'match_persona_description', false),
    matchCharacterDescription: pick('matchCharacterDescription', 'match_character_description', false),
    matchCharacterPersonality: pick('matchCharacterPersonality', 'match_character_personality', false),
    matchCharacterDepthPrompt: pick('matchCharacterDepthPrompt', 'match_character_depth_prompt', false),
    matchScenario: pick('matchScenario', 'match_scenario', false),
    matchCreatorNotes: pick('matchCreatorNotes', 'match_creator_notes', false),
    delayUntilRecursion: pick('delayUntilRecursion', 'delay_until_recursion', 0),
    probability: pick('probability', 'probability', 100),
    useProbability: pick('useProbability', 'useProbability', true),
    depth: pick('depth', 'depth', DEFAULT_DEPTH),
    outletName: raw.outletName ?? '',
    group: pick('group', 'group', ''),
    groupOverride: pick('groupOverride', 'group_override', false),
    groupWeight: pick('groupWeight', 'group_weight', DEFAULT_WEIGHT),
    scanDepth: pick('scanDepth', 'scan_depth', null),
    caseSensitive: pick('caseSensitive', 'case_sensitive', null),
    matchWholeWords: pick('matchWholeWords', 'match_whole_words', null),
    useGroupScoring: pick('useGroupScoring', 'use_group_scoring', null),
    automationId: pick('automationId', 'automation_id', ''),
    role: pick('role', 'role', ROLE.system),
    sticky: pick('sticky', 'sticky', null),
    cooldown: pick('cooldown', 'cooldown', null),
    delay: pick('delay', 'delay', null),
    triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
    extensions: ext,
  }
}

export function normalizeEntry(raw, world, uid) {
  const entry = {
    uid: Number(uid),
    world,
    ...mapEntryShape(raw ?? {}),
  }
  if (entry.delayUntilRecursion === true) entry.delayUntilRecursion = 1
  entry.hash = hashEntry(entry)
  return entry
}

export function normalizeBook(book) {
  const entries = {}
  const source = book?.entries ?? {}
  if (Array.isArray(source)) {
    for (const raw of source) {
      const uid = raw.id ?? raw.uid ?? Object.keys(entries).length
      entries[String(uid)] = normalizeEntry(raw, book.name, uid)
    }
  } else {
    for (const [uid, raw] of Object.entries(source)) {
      entries[uid] = normalizeEntry(raw, book.name, uid)
    }
  }
  return { name: book.name, entries }
}

function bookKey(bookName, uid) {
  return `${bookName}.${uid}`
}

// ---- matching -------------------------------------------------------------

function transformString(value, entry, globals) {
  const caseSensitive = entry.caseSensitive ?? globals.caseSensitive
  return caseSensitive ? value : value.toLowerCase()
}

export function matchKeys(haystack, needle, entry, globals) {
  const regex = parseRegexFromString(needle)
  if (regex) return regex.test(haystack)

  const text = transformString(haystack, entry, globals)
  const key = transformString(needle, entry, globals)
  if (!key) return false

  const wholeWords = entry.matchWholeWords ?? globals.matchWholeWords
  if (wholeWords) {
    if (key.split(/\s+/).length > 1) return text.includes(key)
    return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text)
  }
  return text.includes(key)
}

function appendField(parts, value) {
  if (typeof value === 'string' && value.trim() !== '') {
    parts.push(value)
  }
}

/**
 * The haystack one entry is matched against: the newest `scanDepth` messages
 * followed by whichever character/persona fields the entry opted into, then the
 * recursion buffer.
 */
export function buildScanText(entry, context) {
  const { globals, messages, character, persona, recurseText, scanState, injectText } = context
  const depth = Math.min(entry.scanDepth ?? globals.scanDepth, MAX_SCAN_DEPTH)
  const parts = []
  if (depth > 0) {
    const slice = depth >= messages.length ? messages : messages.slice(-depth)
    const lines = slice.map((message) => {
      const name = message.name ?? defaultNameFor(message.role)
      const text = message.text ?? ''
      return globals.includeNames && name && message.role !== 'system' ? `${name}: ${text}` : text
    })
    parts.push(lines.join(JOINER))
  }

  if (entry.matchPersonaDescription) appendField(parts, persona?.description)
  if (entry.matchCharacterDescription) appendField(parts, character?.description)
  if (entry.matchCharacterPersonality) appendField(parts, character?.personality)
  if (entry.matchCharacterDepthPrompt) appendField(parts, character?.depthPrompt)
  if (entry.matchScenario) appendField(parts, character?.scenario)
  if (entry.matchCreatorNotes) appendField(parts, character?.creatorNotes)
  if (injectText) appendField(parts, injectText)
  if (recurseText && scanState !== SCAN.MIN_ACTIVATIONS) appendField(parts, recurseText)

  return MATCHER + parts.join(JOINER)
}

function defaultNameFor(role) {
  if (role === 'user') return 'User'
  if (role === 'assistant') return 'Assistant'
  return ''
}

// ---- timed effects --------------------------------------------------------

function timedKey(entry) {
  return bookKey(entry.world, entry.uid)
}

function readTimed(state, type, key) {
  return state[type]?.[key]
}

function deleteTimed(state, type, key) {
  if (state[type]) delete state[type][key]
}

/**
 * Evaluates sticky/cooldown for one entry against the current chat length,
 * mirroring `WorldInfoTimedEffects.checkTimedEffectOfType`.
 */
function evaluateTimed(entry, turn, timed) {
  const key = timedKey(entry)
  const active = { sticky: false, cooldown: false }

  for (const type of ['sticky', 'cooldown']) {
    const record = readTimed(timed, type, key)
    if (!record) continue

    if (turn <= record.start && !record.protected) {
      deleteTimed(timed, type, key)
      continue
    }
    if (record.hash !== entry.hash) {
      if (turn >= record.end) deleteTimed(timed, type, key)
      continue
    }
    if (!entry[type]) {
      deleteTimed(timed, type, key)
      continue
    }
    if (turn >= record.end) {
      deleteTimed(timed, type, key)
      if (type === 'sticky' && entry.cooldown) {
        timed.cooldown ??= {}
        timed.cooldown[key] = {
          hash: entry.hash,
          start: turn,
          end: turn + Number(entry.cooldown),
          protected: true,
        }
        if (turn < timed.cooldown[key].end) active.cooldown = true
      }
      continue
    }
    active[type] = true
  }

  active.delay = Boolean(entry.delay) && turn < entry.delay
  return active
}

function writeTimed(entry, turn, timed) {
  const key = timedKey(entry)
  for (const type of ['sticky', 'cooldown']) {
    if (!entry[type]) continue
    timed[type] ??= {}
    if (!timed[type][key]) {
      timed[type][key] = {
        hash: entry.hash,
        start: turn,
        end: turn + Number(entry[type]),
        protected: false,
      }
    }
  }
}

// ---- selective logic ------------------------------------------------------

function matchSecondaryKeys(entry, scanText, globals, macros) {
  const logic = entry.selectiveLogic ?? SELECTIVE_LOGIC.AND_ANY
  const secondaries = (entry.keysecondary ?? [])
    .map((key) => substituteParams(key, macros).trim())
    .filter(Boolean)

  if (!secondaries.length) return true

  const hits = secondaries.map((key) => matchKeys(scanText, key, entry, globals))

  switch (logic) {
    case SELECTIVE_LOGIC.NOT_ALL:
      // "at least one secondary key is absent" — early-true on the first miss.
      return hits.some((hit) => !hit)
    case SELECTIVE_LOGIC.NOT_ANY:
      return !hits.some(Boolean)
    case SELECTIVE_LOGIC.AND_ALL:
      return hits.every(Boolean)
    case SELECTIVE_LOGIC.AND_ANY:
    default:
      return hits.some(Boolean)
  }
}

// ---- groups ---------------------------------------------------------------

function selectFromGroups(entries, activated, rng) {
  const grouped = new Map()
  for (const entry of entries) {
    if (!entry.group) continue
    for (const name of String(entry.group).split(/,\s*/).filter(Boolean)) {
      if (!grouped.has(name)) grouped.set(name, [])
      grouped.get(name).push(entry)
    }
  }
  const excluded = new Set()
  for (const [, members] of grouped) {
    const alive = members.filter((entry) => !activated.has(bookKey(entry.world, entry.uid)))
    if (!alive.length) {
      for (const entry of members) excluded.add(entry)
      continue
    }
    const override = alive.find((entry) => entry.groupOverride)
    let winner
    if (override) {
      winner = alive.reduce((best, entry) => (entry.order > best.order ? entry : best), override)
    } else {
      const total = alive.reduce((sum, entry) => sum + (Number(entry.groupWeight) || DEFAULT_WEIGHT), 0)
      let roll = rng() * total
      winner = alive[alive.length - 1]
      for (const entry of alive) {
        roll -= Number(entry.groupWeight) || DEFAULT_WEIGHT
        if (roll <= 0) {
          winner = entry
          break
        }
      }
    }
    for (const entry of members) {
      if (entry !== winner) excluded.add(entry)
    }
  }
  return entries.filter((entry) => !excluded.has(entry))
}

// ---- main scan ------------------------------------------------------------

function compareEntries(a, b) {
  if (a.bookRank !== b.bookRank) return a.bookRank - b.bookRank
  if (a.order !== b.order) return b.order - a.order
  return a.uid - b.uid
}

/**
 * Runs one activation scan.
 *
 * @param {object} input
 * @param {Array<{name: string, entries: object, kind?: 'character'|'global'}>} input.books
 * @param {Array<{role: string, text: string, name?: string}>} input.messages chronological
 * @param {object} [input.character] name/description/personality/scenario/depthPrompt/creatorNotes
 * @param {object} [input.persona] name/description
 * @param {object} [input.options]
 * @param {object} [input.timed] mutable { sticky, cooldown }
 * @param {number} [input.turn] chat length driving timed effects
 * @param {() => number} [input.rng]
 */
export function scanWorldInfo(input) {
  const {
    books = [],
    messages = [],
    character = {},
    persona = {},
    options = {},
    rng = Math.random,
  } = input

  const globals = {
    scanDepth: options.scanDepth ?? 4,
    caseSensitive: options.caseSensitive ?? false,
    matchWholeWords: options.matchWholeWords ?? false,
    includeNames: options.includeNames ?? true,
  }
  const turn = input.turn ?? messages.length
  const timed = structuredClone(input.timed ?? { sticky: {}, cooldown: {} })
  const macros = { char: character.name ?? '', user: persona.name ?? 'User', persona: persona.name ?? 'User' }
  const budget = Math.max(
    1,
    Math.round(((options.budgetPercent ?? 25) * (options.maxContext ?? 8192)) / 100),
  )
  const cappedBudget = options.budgetCap > 0 ? Math.min(budget, options.budgetCap) : budget

  const entries = []
  for (const book of books) {
    const rank = book.kind === 'character' ? 0 : 1
    for (const raw of Object.values(book.entries ?? {})) {
      entries.push({ ...raw, bookRank: rank })
    }
  }
  entries.sort(compareEntries)

  if (!entries.length) {
    return { before: '', after: '', depth: [], outlets: {}, anTop: [], anBottom: [], activated: [], overflowed: false, timed }
  }

  const activated = new Map()
  const failedProbability = new Set()
  let recurseText = ''
  let overflowed = false
  let scanState = SCAN.INITIAL
  let passes = 0
  let minActivationsDepth = globals.scanDepth
  const maxSteps = options.maxRecursionSteps ?? 2
  const maxPasses = Math.max(1, maxSteps)

  const delayLevels = [...new Set(entries.filter((entry) => entry.delayUntilRecursion).map((entry) => entry.delayUntilRecursion))].sort((a, b) => a - b)
  let currentDelayLevel = delayLevels.shift() ?? 0

  while (scanState) {
    if (maxPasses && passes >= maxPasses) break
    passes++
    const scanForThisPass = scanState
    const activatedNow = new Set()
    let nextState = SCAN.NONE

    for (const entry of entries) {
      const key = bookKey(entry.world, entry.uid)
      if (failedProbability.has(entry) || activated.has(key)) continue
      if (entry.disable) continue
      if (entry.triggers.length && !entry.triggers.includes(options.trigger ?? 'normal')) continue

      const timedState = evaluateTimed(entry, turn, timed)
      if (timedState.delay) continue
      if (timedState.cooldown && !timedState.sticky) continue
      if (scanForThisPass !== SCAN.RECURSION && entry.delayUntilRecursion && !timedState.sticky) continue
      if (scanForThisPass === SCAN.RECURSION && entry.delayUntilRecursion > currentDelayLevel && !timedState.sticky) continue
      if (scanForThisPass === SCAN.RECURSION && options.recursive && entry.excludeRecursion && !timedState.sticky) continue

      const scanText = buildScanText(entry, {
        globals: {
          ...globals,
          scanDepth: scanForThisPass === SCAN.MIN_ACTIVATIONS ? minActivationsDepth : globals.scanDepth,
        },
        messages,
        character,
        persona,
        recurseText,
        scanState: scanForThisPass,
      })

      if (entry.constant) {
        activatedNow.add(entry)
        continue
      }
      if (timedState.sticky) {
        activatedNow.add(entry)
        continue
      }
      if (!entry.key.length) continue

      const primary = entry.key.find((needle) => {
        const resolved = substituteParams(needle, macros).trim()
        return resolved && matchKeys(scanText, resolved, entry, globals)
      })
      if (!primary) continue

      const hasSecondary = entry.selective && entry.keysecondary.length > 0
      if (!hasSecondary) {
        activatedNow.add(entry)
        continue
      }
      if (matchSecondaryKeys(entry, scanText, globals, macros)) {
        activatedNow.add(entry)
      }
    }

    let newEntries = [...activatedNow]
    if (newEntries.length > 1) {
      const index = new Map(entries.map((entry, i) => [entry, i]))
      newEntries.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
    }

    newEntries = selectFromGroups(newEntries, activated, rng)

    let newContent = ''
    let ignoresBudget = newEntries.filter((entry) => entry.ignoreBudget).length

    for (const entry of newEntries) {
      if (entry.ignoreBudget) ignoresBudget--
      if (overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue
        break
      }
      if (entry.useProbability && entry.probability < 100) {
        failedProbability.add(entry)
        if (rng() * 100 > entry.probability) continue
        failedProbability.delete(entry)
      }

      const content = substituteParams(entry.content, macros)
      newContent += `${content}\n`

      if (!entry.ignoreBudget && estimateTokens(newContent) + estimateTokens(recurseText) >= cappedBudget) {
        overflowed = true
        failedProbability.delete(entry)
        continue
      }
      const copy = { ...entry, content }
      activated.set(bookKey(entry.world, entry.uid), copy)
    }

    const successful = newEntries.filter((entry) => !failedProbability.has(entry))
    const forRecursion = successful.filter((entry) => !entry.preventRecursion)

    if (options.recursive && !overflowed && forRecursion.length) {
      nextState = SCAN.RECURSION
    }
    if (options.recursive && !overflowed && scanForThisPass === SCAN.MIN_ACTIVATIONS && recurseText) {
      nextState = SCAN.RECURSION
    }
    const minNotSatisfied = (options.minActivations ?? 0) > 0 && activated.size < options.minActivations
    if (!nextState && !overflowed && minNotSatisfied) {
      const depthMax = options.minActivationsDepthMax ?? 0
      const overMax = (depthMax > 0 && minActivationsDepth > depthMax) || minActivationsDepth > messages.length
      if (!overMax) {
        nextState = SCAN.MIN_ACTIVATIONS
        minActivationsDepth++
      }
    }
    if (nextState === SCAN.NONE && delayLevels.length) {
      nextState = SCAN.RECURSION
      currentDelayLevel = delayLevels.shift()
    }

    scanState = nextState
    if (scanState) {
      const text = forRecursion.map((entry) => substituteParams(entry.content, macros)).join('\n')
      if (text) {
        recurseText = recurseText ? `${text}\n${recurseText}` : text
      }
    }
  }

  for (const entry of activated.values()) {
    writeTimed(entry, turn, timed)
  }

  // ---- buckets ------------------------------------------------------------

  const ordered = [...activated.values()].sort((a, b) => b.order - a.order || a.uid - b.uid)
  const before = []
  const after = []
  const anTop = []
  const anBottom = []
  const emTop = []
  const emBottom = []
  const outlets = {}
  const depthGroups = []

  for (const entry of ordered) {
    const content = entry.content
    if (!content) continue
    switch (entry.position) {
      case POSITION.before:
        before.unshift(content)
        break
      case POSITION.after:
        after.unshift(content)
        break
      case POSITION.anTop:
        anTop.unshift(content)
        break
      case POSITION.anBottom:
        anBottom.unshift(content)
        break
      case POSITION.emTop:
        emTop.unshift(content)
        break
      case POSITION.emBottom:
        emBottom.unshift(content)
        break
      case POSITION.outlet: {
        const name = entry.outletName || 'default'
        outlets[name] ??= []
        outlets[name].push(content)
        break
      }
      case POSITION.atDepth:
      default: {
        const depth = entry.depth ?? DEFAULT_DEPTH
        const role = entry.role ?? ROLE.system
        const existing = depthGroups.find((group) => group.depth === depth && group.role === role)
        if (existing) existing.entries.unshift(content)
        else depthGroups.push({ depth, role, entries: [content] })
        break
      }
    }
  }

  return {
    before: before.join('\n'),
    after: after.join('\n'),
    anTop,
    anBottom,
    emTop,
    emBottom,
    outlets,
    depth: depthGroups,
    activated: [...activated.values()].map((entry) => ({
      world: entry.world,
      uid: entry.uid,
      comment: entry.comment,
      position: entry.position,
      order: entry.order,
      tokens: estimateTokens(entry.content),
    })),
    overflowed,
    timed,
    passes,
  }
}

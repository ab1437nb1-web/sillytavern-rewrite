/**
 * The shared runtime behind the three plugin rows.
 *
 * Characters, World Info and Presets are separate Loader rows with separate
 * configs, but they operate on one library and produce one system-prompt
 * section. This module owns that shared state: the store, the binding table,
 * the composed prompt per session, and the single registration that injects it.
 *
 * Row order does not matter. The first row to attach becomes the "leader" and
 * owns the agent hooks; if it unloads, the next attached row takes over.
 */
import { resolveDataDir } from './config.js'
import { mountApi } from './api.js'
import { decodeCard, encodeCardPng, cardToJsonBuffer, greetingsOf, normalizeCard } from './card.js'
import { buildPromptText, normalizePreset, DEFAULT_MAIN_PROMPT } from './prompt.js'
import { scanWorldInfo, normalizeBook } from './worldinfo.js'
import { Store } from './store.js'

const runtimes = new Map()

export function getRuntime(config = {}) {
  const dir = resolveDataDir(config.dataDir)
  let runtime = runtimes.get(dir)
  if (!runtime) {
    runtime = new Runtime(dir)
    runtimes.set(dir, runtime)
  }
  return runtime
}

export const SECTION_NAME = 'sillytavern'
export const SECTION_ORDER = 700
const DEFAULT_MAX_CONTEXT = 8192

function messageText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof message.text === 'string') return message.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
  }
  return ''
}

export class Runtime {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.store = new Store(dataDir)
    this.ready = this.store.init()
    this.parts = new Map()
    this.leader = null
    this.releaseLeader = null
    this.perAgent = new Map()
    this.promptCache = new Map()
    this.timed = new Map()
    this.agentRefs = new Map()
  }

  // ---- row lifecycle -----------------------------------------------------

  attach(role, ctx, config) {
    this.parts.set(role, { ctx, config })
    if (!this.leader) this.install(ctx)
  }

  detach(role) {
    const part = this.parts.get(role)
    this.parts.delete(role)
    if (part && part.ctx === this.leader) {
      this.releaseLeader?.()
      this.releaseLeader = null
      this.releaseHttp?.()
      this.releaseHttp = null
      this.leader = null
      const next = [...this.parts.values()][0]
      if (next) this.install(next.ctx)
    }
  }

  configOf(role) {
    return this.parts.get(role)?.config ?? {}
  }

  ensureHttp(ctx) {
    if (this.releaseHttp) return
    const release = ctx.inject(['webServer'], (scoped) => {
      const off = mountApi(this, scoped, scoped.webServer)
      scoped.effect(() => () => off())
    })
    this.releaseHttp = typeof release === 'function' ? release : () => {}
  }

  has(role) {
    return this.parts.has(role)
  }

  install(ctx) {
    this.leader = ctx
    this.ensureHttp(ctx)
    this.releaseLeader = ctx.effect(() => {
      const offCreated = ctx.on('agent/created', ({ agent }) => {
        this.agentRefs.set(agent.id, agent)
        void this.refresh(agent)
      })
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        this.perAgent.get(agent.id)?.()
        this.perAgent.delete(agent.id)
        this.promptCache.delete(agent.id)
        this.timed.delete(agent.id)
        this.agentRefs.delete(agent.id)
      })
      // Recompute after the events that change what the prompt should say.
      const offEvent = ctx.on('session/event', (session, event) => {
        if (!session || !this.agentRefs.has(session.id)) return
        if (!['user/message', 'assistant/message', 'tool/result'].includes(event?.type)) return
        const agent = this.agentRefs.get(session.id)
        if (agent) void this.refresh(agent)
      })
      return () => {
        offCreated()
        offDisposed()
        offEvent()
        for (const dispose of this.perAgent.values()) dispose()
        this.perAgent.clear()
      }
    })
  }

  // ---- session state -----------------------------------------------------

  async binding(sessionId) {
    return this.store.bindingFor(sessionId)
  }

  async setBinding(sessionId, patch) {
    const state = await this.store.updateState((state) => {
      const key = sessionId ?? 'default'
      const table = sessionId ? 'sessions' : 'defaults'
      const current = state[table][key] ?? {}
      const next = { ...current, ...patch }
      for (const field of ['characterId', 'presetId', 'personaId']) {
        if (next[field] === null) delete next[field]
      }
      if (Array.isArray(next.worldbookIds) && next.worldbookIds.length === 0) delete next.worldbookIds
      if (Object.keys(next).length === 0) delete state[table][key]
      else state[table][key] = next
      return state
    })
    const table = sessionId ? state.sessions : state.defaults
    return table[sessionId ?? 'default'] ?? {}
  }

  // ---- library operations ------------------------------------------------

  async listCharacters() {
    const { docs } = await this.store.list('characters')
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      creator: doc.creator,
      tags: doc.tags,
      hasAvatar: Boolean(doc.avatar),
      updatedAt: doc.updatedAt,
      descriptionPreview: (doc.description ?? '').slice(0, 160),
    }))
  }

  async getCharacter(id) {
    return this.store.get('characters', id)
  }

  async importCharacter(buffer, filename = '') {
    const decoded = decodeCard(buffer, { filename })
    const card = decoded.card
    if (!card.name) throw new Error('character card has no name')
    const existing = (await this.store.list('characters')).docs.find((doc) => doc.name === card.name)
    const record = await this.store.put('characters', {
      ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
      ...card,
      format: card.format,
      avatar: decoded.png ? 'png' : null,
      importedFrom: filename,
    })
    if (decoded.png) {
      await this.store.writeBytes('characters', record.id, 'png', decoded.png)
    } else if (decoded.icon) {
      await this.store.writeBytes('characters', record.id, 'png', decoded.icon)
    }
    return record
  }

  async exportCharacter(id, format = 'png') {
    const card = await this.store.get('characters', id)
    if (!card) throw new Error('unknown character')
    if (format === 'json') return { buffer: cardToJsonBuffer(card), contentType: 'application/json', filename: `${card.name}.json` }
    const png = await this.store.readBytes('characters', id, 'png')
    if (!png) throw new Error('character has no image to embed metadata in; import it from a PNG or export JSON')
    return { buffer: encodeCardPng(png, card), contentType: 'image/png', filename: `${card.name}.png` }
  }

  async deleteCharacter(id) {
    return this.store.remove('characters', id)
  }

  async listWorlds() {
    const { docs } = await this.store.list('worlds')
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      entries: Object.keys(doc.entries ?? {}).length,
      updatedAt: doc.updatedAt,
    }))
  }

  async getWorld(id) {
    return this.store.get('worlds', id)
  }

  async importWorld(raw, name) {
    const entries = raw?.entries ?? raw
    if (!entries || typeof entries !== 'object') throw new Error('world info file has no entries')
    const bookName = name || raw?.name || 'Imported world'
    const existing = (await this.store.list('worlds')).docs.find((doc) => doc.name === bookName)
    return this.store.put('worlds', {
      ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
      name: bookName,
      entries,
    })
  }

  async deleteWorld(id) {
    return this.store.remove('worlds', id)
  }

  async putWorldEntry(worldId, uid, patch) {
    const world = await this.store.get('worlds', worldId)
    if (!world) throw new Error('unknown world')
    const entries = { ...(world.entries ?? {}) }
    let key = uid
    if (key === undefined || key === null || key === '') {
      key = 0
      while (entries[String(key)]) key++
    }
    entries[String(key)] = { ...(entries[String(key)] ?? {}), ...patch, uid: Number(key) }
    return this.store.put('worlds', { ...world, entries })
  }

  async deleteWorldEntry(worldId, uid) {
    const world = await this.store.get('worlds', worldId)
    if (!world) throw new Error('unknown world')
    const entries = { ...(world.entries ?? {}) }
    delete entries[String(uid)]
    return this.store.put('worlds', { ...world, entries })
  }

  async listPresets() {
    const { docs } = await this.store.list('presets')
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      prompts: (doc.prompts ?? []).length,
      updatedAt: doc.updatedAt,
    }))
  }

  async getPreset(id) {
    return this.store.get('presets', id)
  }

  async importPreset(raw, name) {
    const preset = normalizePreset(raw, name || raw?.name)
    const existing = (await this.store.list('presets')).docs.find((doc) => doc.name === preset.name)
    return this.store.put('presets', {
      ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
      ...preset,
      raw: undefined,
    })
  }

  async deletePreset(id) {
    return this.store.remove('presets', id)
  }

  // ---- the `<user>` identity --------------------------------------------

  async listPersonas() {
    const { docs } = await this.store.list('personas')
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      descriptionPreview: (doc.description ?? '').slice(0, 160),
      updatedAt: doc.updatedAt,
    }))
  }

  async getPersona(id) {
    return this.store.get('personas', id)
  }

  /** Creates or updates a persona; the name must be unique enough to pick by. */
  async savePersona({ id, name, description }) {
    if (!name || !String(name).trim()) throw new Error('persona needs a name')
    const existing = id ? await this.store.get('personas', id) : null
    return this.store.put('personas', {
      ...(existing ?? {}),
      name: String(name).trim(),
      description: String(description ?? ''),
    })
  }

  async deletePersona(id) {
    return this.store.remove('personas', id)
  }

  async personaFor(binding) {
    if (!binding?.personaId) return { name: 'User', description: '' }
    const persona = await this.store.get('personas', binding.personaId)
    if (!persona) return { name: 'User', description: '' }
    return { name: persona.name || 'User', description: persona.description ?? '' }
  }

  /** The preset the runtime falls back to when a session binds none. */
  async fallbackPreset() {
    const configured = this.configOf('presets').defaultPreset
    if (configured) {
      const byName = (await this.store.list('presets')).docs.find((doc) => doc.name === configured)
      if (byName) return byName
    }
    const { docs } = await this.store.list('presets')
    return docs[0] ?? null
  }

  // ---- composition -------------------------------------------------------

  async refresh(agent) {
    try {
      const text = await this.compose(agent)
      this.promptCache.set(agent.id, text)
    } catch (error) {
      this.promptCache.set(agent.id, `[sillytavern] failed to compose the character prompt: ${error.message}`)
    }
    try {
      this.ensureSection(agent)
    } catch (error) {
      // A harness without the prompt registry must not lose the whole agent.
      console.error('[dsh-sillytavern] cannot register the prompt section:', error)
    }
  }

  async compose(agent) {
    const binding = await this.binding(agent.id)
    const character = binding.characterId ? await this.store.get('characters', binding.characterId) : null
    const persona = await this.personaFor(binding)
    const presetDoc = (binding.presetId ? await this.store.get('presets', binding.presetId) : null) ?? (await this.fallbackPreset())
    const preset = presetDoc ? normalizePreset(presetDoc, presetDoc.name) : normalizePreset({}, 'Built-in')

    const books = []
    for (const id of binding.worldbookIds ?? []) {
      const world = await this.store.get('worlds', id)
      if (!world) continue
      books.push({ name: world.name, entries: normalizeBook(world).entries, kind: 'global' })
    }
    if (character?.characterBook) {
      books.push({
        name: `${character.name} (embedded)`,
        entries: normalizeBook({ name: `${character.name} (embedded)`, entries: character.characterBook.entries }).entries,
        kind: 'character',
      })
    }

    const messages = this.messagesOf(agent)
    const wbConfig = this.configOf('worldbook')
    let worldInfo = { before: '', after: '' }
    if (books.length) {
      const timed = this.timed.get(agent.id) ?? { sticky: {}, cooldown: {} }
      const scan = scanWorldInfo({
        books,
        messages,
        character: {
          name: character?.name,
          description: character?.description,
          personality: character?.personality,
          scenario: character?.scenario,
          depthPrompt: character?.depthPrompt?.prompt,
          creatorNotes: character?.creatorNotes,
        },
        persona,
        options: {
          scanDepth: wbConfig.scanDepth ?? 4,
          budgetPercent: 25,
          maxContext: preset.maxContext ?? DEFAULT_MAX_CONTEXT,
          budgetCap: wbConfig.tokenBudget ?? 0,
          recursive: wbConfig.recursive ?? true,
          maxRecursionSteps: wbConfig.maxRecursionSteps ?? 2,
          caseSensitive: wbConfig.caseSensitive ?? false,
          matchWholeWords: wbConfig.matchWholeWords ?? false,
        },
        turn: messages.length,
        timed,
      })
      this.timed.set(agent.id, scan.timed)
      worldInfo = { before: scan.before, after: scan.after, activated: scan.activated, depth: scan.depth }
    }

    const characterForPrompt = character
      ? {
        ...character,
        description: [character.description, character.depthPrompt?.prompt].filter(Boolean).join('\n'),
      }
      : null

    const built = buildPromptText({
      preset,
      character: characterForPrompt,
      worldInfo,
      persona,
      macros: {},
    })

    if (!character && !books.length && !presetDoc && !persona.description) return ''

    const depthText = (worldInfo.depth ?? [])
      .map((group) => group.entries.join('\n'))
      .filter(Boolean)
      .join('\n\n')

    return [built.text, depthText].filter(Boolean).join('\n\n')
  }

  messagesOf(agent) {
    const sessions = this.leader?.get?.('sessions')
    const session = sessions?.get?.(agent.id)
    if (!session) return []
    return session
      .deriveMessages()
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, text: messageText(message) }))
  }

  ensureSection(agent) {
    if (this.perAgent.has(agent.id)) return
    if (!agent?.ctx?.systemPrompt?.section) return
    const dispose = agent.ctx.effect(() => {
      const offSection = agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => this.promptCache.get(agent.id) ?? '',
      })
      const offRequest = agent.ctx.on('agent/request', async (payload, next) => {
        const config = await next()
        return this.applySamplers(agent.id, config)
      })
      return () => {
        offSection()
        offRequest()
      }
    })
    this.perAgent.set(agent.id, dispose)
  }

  async applySamplers(sessionId, config) {
    const binding = await this.binding(sessionId)
    const presetDoc = (binding.presetId ? await this.store.get('presets', binding.presetId) : null) ?? (await this.fallbackPreset())
    if (!presetDoc) return config
    const preset = normalizePreset(presetDoc, presetDoc.name)
    const next = { ...config }
    if (Number.isFinite(preset.temperature)) next.temperature = preset.temperature
    if (preset.maxTokens) next.maxTokens = preset.maxTokens
    if (preset.stop.length) next.stop = preset.stop
    return next
  }

  /** Scans a world against arbitrary text — used by the scan tool and the UI. */
  async testWorld(worldId, text, options = {}) {
    const world = await this.store.get('worlds', worldId)
    if (!world) throw new Error('unknown world')
    const wbConfig = this.configOf('worldbook')
    const scan = scanWorldInfo({
      books: [{ name: world.name, entries: normalizeBook(world).entries, kind: 'global' }],
      messages: [{ role: 'user', text }],
      options: {
        scanDepth: options.scanDepth ?? wbConfig.scanDepth ?? 4,
        recursive: options.recursive ?? wbConfig.recursive ?? true,
        maxRecursionSteps: wbConfig.maxRecursionSteps ?? 2,
        maxContext: options.maxContext ?? DEFAULT_MAX_CONTEXT,
        budgetPercent: 25,
        budgetCap: wbConfig.tokenBudget ?? 0,
      },
      turn: 1,
    })
    return scan
  }

  /** A composed preview for the UI, without a live session. */
  async preview({ characterId, worldbookIds = [], presetId, personaId, sampleText = '' }) {
    const character = characterId ? await this.store.get('characters', characterId) : null
    const persona = await this.personaFor({ personaId })
    const presetDoc = (presetId ? await this.store.get('presets', presetId) : null) ?? (await this.fallbackPreset())
    const preset = presetDoc ? normalizePreset(presetDoc, presetDoc.name) : normalizePreset({}, 'Built-in')
    const books = []
    for (const id of worldbookIds) {
      const world = await this.store.get('worlds', id)
      if (world) books.push({ name: world.name, entries: normalizeBook(world).entries, kind: 'global' })
    }
    const scan = books.length
      ? scanWorldInfo({
        books,
        messages: sampleText ? [{ role: 'user', text: sampleText }] : [],
        character,
        persona,
        options: { scanDepth: 4, recursive: true, maxRecursionSteps: 2, maxContext: preset.maxContext ?? DEFAULT_MAX_CONTEXT, budgetPercent: 25 },
        turn: sampleText ? 1 : 0,
      })
      : { before: '', after: '', depth: [], activated: [] }

    const built = buildPromptText({ preset, character, worldInfo: scan, persona })
    return { system: built.text, activated: scan.activated ?? [], depth: built.depth, persona: persona.name }
  }
}

export { greetingsOf, normalizeCard, DEFAULT_MAIN_PROMPT }

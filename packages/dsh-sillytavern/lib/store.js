/**
 * File-backed library storage shared by the three systems.
 *
 * Layout under `<dataDir>`:
 *   characters/<id>.json   normalized card (the original bytes, when the card
 *                          came from a PNG, live beside it as <id>.png)
 *   worlds/<id>.json       world info book in SillyTavern's on-disk shape
 *   presets/<id>.json      chat preset (prompt manager + samplers)
 *   state.json             session bindings and global defaults
 *
 * Writes are atomic (temp file + rename) so a crash cannot truncate a library,
 * and every read goes through a small in-memory cache invalidated on write.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const KINDS = ['characters', 'worlds', 'presets']

const EMPTY_STATE = { version: 1, sessions: {}, defaults: {} }

function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.cache = new Map()
    this.stateCache = null
    this.listeners = new Set()
    this.queue = Promise.resolve()
  }

  path(...parts) {
    return join(this.dataDir, ...parts)
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    for (const kind of KINDS) {
      await mkdir(this.path(kind), { recursive: true })
    }
  }

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(change) {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A broken observer must never fail a write.
      }
    }
  }

  /** Serializes mutations so two concurrent imports cannot interleave renames. */
  async exclusive(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return fallback
      throw error
    }
  }

  async writeAtomic(file, value) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await rename(temp, file)
  }

  // ---- documents ---------------------------------------------------------

  async list(kind) {
    const cached = this.cache.get(kind)
    if (cached?.index) return cached.index
    const dir = this.path(kind)
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    const docs = []
    for (const name of names) {
      const doc = await this.readJson(join(dir, name), null)
      if (doc) docs.push(doc)
    }
    docs.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
    const index = { docs, at: Date.now() }
    this.cache.set(kind, { index })
    return index
  }

  async get(kind, id) {
    const { docs } = await this.list(kind)
    return docs.find((doc) => doc.id === id) ?? null
  }

  async put(kind, doc) {
    return this.exclusive(async () => {
      const id = doc.id ?? newId()
      const record = { ...doc, id, updatedAt: Date.now(), createdAt: doc.createdAt ?? Date.now() }
      await this.writeAtomic(this.path(kind, `${id}.json`), record)
      this.cache.delete(kind)
      this.emit({ kind, id, type: 'put' })
      return record
    })
  }

  async remove(kind, id) {
    return this.exclusive(async () => {
      await rm(this.path(kind, `${id}.json`), { force: true })
      await rm(this.path(kind, `${id}.png`), { force: true })
      this.cache.delete(kind)
      this.emit({ kind, id, type: 'remove' })
      return true
    })
  }

  async writeBytes(kind, id, extension, bytes) {
    return this.exclusive(async () => {
      const file = this.path(kind, `${id}.${extension}`)
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, bytes)
      await rename(temp, file)
      return file
    })
  }

  async readBytes(kind, id, extension) {
    try {
      return await readFile(this.path(kind, `${id}.${extension}`))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  // ---- state -------------------------------------------------------------

  async state() {
    if (this.stateCache) return this.stateCache
    const raw = await this.readJson(this.path('state.json'), null)
    this.stateCache = { ...EMPTY_STATE, ...(raw ?? {}) }
    this.stateCache.sessions ??= {}
    this.stateCache.defaults ??= {}
    return this.stateCache
  }

  async updateState(mutate) {
    return this.exclusive(async () => {
      const current = await this.state()
      const next = { ...current, ...mutate(structuredClone(current)) }
      this.stateCache = next
      await this.writeAtomic(this.path('state.json'), next)
      this.emit({ kind: 'state', type: 'put' })
      return next
    })
  }

  /** The binding in force for a session: its own row, else the global default. */
  async bindingFor(sessionId) {
    const state = await this.state()
    const own = sessionId ? state.sessions[sessionId] : undefined
    const defaults = state.defaults ?? {}
    return {
      characterId: own?.characterId ?? defaults.characterId ?? null,
      worldbookIds: own?.worldbookIds ?? defaults.worldbookIds ?? [],
      presetId: own?.presetId ?? defaults.presetId ?? null,
      greetingIndex: own?.greetingIndex ?? 0,
      sessionId: sessionId ?? null,
      inherited: {
        characterId: !own?.characterId && Boolean(defaults.characterId),
        worldbookIds: !own?.worldbookIds && Boolean(defaults.worldbookIds?.length),
        presetId: !own?.presetId && Boolean(defaults.presetId),
      },
    }
  }
}

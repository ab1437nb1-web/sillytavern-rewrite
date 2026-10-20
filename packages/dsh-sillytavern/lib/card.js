/**
 * Character-card reading and writing for the three on-disk formats SillyTavern
 * accepts: PNG (metadata in `tEXt` chunks), plain JSON (v1/v2/v3), and CHARX
 * (a ZIP whose `card.json` carries the payload).
 *
 * The normalized card keeps SillyTavern's snake_case → camelCase mapping so the
 * prompt builder and the editor do not have to re-derive it from `data`.
 */
import { inflateRawSync } from 'node:zlib'

import { isPng, readTextChunks, writeTextChunks } from './png.js'

export const PNG_KEYWORD_V2 = 'chara'
export const PNG_KEYWORD_V3 = 'ccv3'

const DEFAULT_DEPTH_PROMPT = { prompt: '', depth: 4, role: 'system' }

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function depthPromptOf(extensions) {
  const raw = extensions?.depth_prompt
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DEPTH_PROMPT }
  return {
    prompt: asString(raw.prompt),
    depth: Number.isFinite(Number(raw.depth)) ? Number(raw.depth) : 4,
    role: ['system', 'user', 'assistant'].includes(raw.role) ? raw.role : 'system',
  }
}

/**
 * Builds the normalized card from any of the three JSON shapes.
 * Missing fields become their SillyTavern defaults rather than `undefined`, so
 * the prompt builder never has to guard every read.
 */
export function normalizeCard(raw, format = 'json') {
  const spec = typeof raw?.spec === 'string' ? raw.spec : 'chara_card_v1'
  const isV2Plus = Boolean(raw?.data && typeof raw.data === 'object' && spec.startsWith('chara_card_v'))
  const data = isV2Plus ? raw.data : raw
  const extensions = data?.extensions && typeof data.extensions === 'object' ? data.extensions : {}

  return {
    spec: isV2Plus ? spec : 'chara_card_v1',
    specVersion: isV2Plus ? String(raw.spec_version ?? '') : '',
    format,
    name: asString(data?.name).trim(),
    description: asString(data?.description).trim(),
    personality: asString(data?.personality).trim(),
    scenario: asString(data?.scenario).trim(),
    firstMes: asString(data?.first_mes).trim(),
    mesExample: asString(data?.mes_example),
    creatorNotes: asString(isV2Plus ? data?.creator_notes : raw?.creatorcomment).trim(),
    systemPrompt: asString(data?.system_prompt).trim(),
    postHistoryInstructions: asString(data?.post_history_instructions).trim(),
    alternateGreetings: asArray(data?.alternate_greetings).map((entry) => asString(entry)),
    groupOnlyGreetings: asArray(data?.group_only_greetings).map((entry) => asString(entry)),
    tags: asArray(data?.tags).map((tag) => asString(tag)).filter(Boolean),
    creator: asString(data?.creator).trim(),
    characterVersion: asString(data?.character_version).trim(),
    extensions,
    depthPrompt: depthPromptOf(extensions),
    characterBook: data?.character_book && typeof data.character_book === 'object' ? data.character_book : null,
  }
}

/** Serializes a normalized card back to the v2 `data` shape SillyTavern writes. */
export function serializeCard(card) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.firstMes,
      mes_example: card.mesExample,
      creator_notes: card.creatorNotes,
      system_prompt: card.systemPrompt,
      post_history_instructions: card.postHistoryInstructions,
      alternate_greetings: card.alternateGreetings,
      tags: card.tags,
      creator: card.creator,
      character_version: card.characterVersion,
      extensions: {
        ...card.extensions,
        depth_prompt: card.depthPrompt,
      },
      ...(card.characterBook ? { character_book: card.characterBook } : {}),
    },
  }
}

// ---- ZIP (CHARX) ----------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/** Reads the entries of a ZIP archive into memory (no ZIP64, no encryption). */
export function readZip(buffer) {
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 65558; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    let bytes = raw
    if (method === 8) bytes = inflateRawSync(raw)
    else if (method !== 0) throw new Error(`unsupported ZIP method ${method} for ${name}`)

    entries.push({ name, bytes })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50
}

// ---- decoding -------------------------------------------------------------

export function decodeCardJson(text, format) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`card metadata is not valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('card metadata is not an object')
  return normalizeCard(parsed, format)
}

/**
 * Decodes a card file. Returns the normalized card, plus the raw PNG bytes for
 * PNG cards so the library can keep the original artwork.
 */
export function decodeCard(buffer, { filename = '' } = {}) {
  if (isPng(buffer)) {
    const chunks = readTextChunks(buffer, [PNG_KEYWORD_V3, PNG_KEYWORD_V2])
    const payload = chunks[PNG_KEYWORD_V3] ?? chunks[PNG_KEYWORD_V2]
    if (!payload) throw new Error('PNG has no "chara" or "ccv3" metadata chunk')
    const json = Buffer.from(payload, 'base64').toString('utf8')
    const card = decodeCardJson(json, 'png')
    return { card, png: buffer }
  }

  if (isZip(buffer)) {
    const entries = readZip(buffer)
    const cardEntry = entries.find((entry) => entry.name.endsWith('card.json') && !entry.name.startsWith('__MACOSX'))
    if (!cardEntry) throw new Error('CHARX archive has no card.json')
    const card = decodeCardJson(cardEntry.bytes.toString('utf8'), 'charx')
    const icon = entries.find((entry) => /(^|\/)icon\.[a-z0-9]+$/i.test(entry.name))
      ?? entries.find((entry) => /(^|\/)main\.[a-z0-9]+$/i.test(entry.name))
    return { card, png: null, charxAssets: entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })), icon: icon?.bytes ?? null }
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  if (!text.trim().startsWith('{')) {
    throw new Error(`unsupported card file${filename ? ` "${filename}"` : ''}: expected PNG, CHARX or JSON`)
  }
  return { card: decodeCardJson(text, 'json'), png: null }
}

export function encodeCardPng(pngBuffer, card) {
  const json = JSON.stringify(serializeCard(card))
  const base64 = Buffer.from(json, 'utf8').toString('base64')
  return writeTextChunks(pngBuffer, { [PNG_KEYWORD_V2]: base64, [PNG_KEYWORD_V3]: base64 })
}

export function cardToJsonBuffer(card) {
  return Buffer.from(JSON.stringify(serializeCard(card), null, 2), 'utf8')
}

/** All greetings in the order the picker shows them. */
export function greetingsOf(card) {
  return [card.firstMes, ...card.alternateGreetings].filter((text) => typeof text === 'string' && text.length > 0)
}

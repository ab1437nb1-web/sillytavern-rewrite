/**
 * Minimal PNG chunk codec: enough to read and rewrite the `tEXt` chunks that
 * carry SillyTavern character-card metadata, without touching pixel data.
 *
 * A PNG is: 8-byte signature, then chunks of
 *   length (u32 BE) | type (4 ASCII) | data (length bytes) | crc32 (u32 BE over type+data)
 * terminated by an IEND chunk.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE)
}

/** Every chunk, in file order, with its raw payload. */
export function readChunks(buffer) {
  if (!isPng(buffer)) {
    throw new Error('not a PNG file')
  }
  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) {
      throw new Error(`truncated PNG chunk ${type}`)
    }
    chunks.push({ type, data: buffer.subarray(start, end) })
    offset = end + 4
    if (type === 'IEND') break
  }
  return chunks
}

export function encodeChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * Reads `tEXt` chunks whose keyword is one of `keywords` as UTF-8 text.
 * SillyTavern stores base64 in the text payload; decoding is the caller's job.
 */
export function readTextChunks(buffer, keywords) {
  const wanted = new Set(keywords)
  const out = {}
  for (const chunk of readChunks(buffer)) {
    if (chunk.type !== 'tEXt') continue
    const nul = chunk.data.indexOf(0)
    if (nul < 0) continue
    const keyword = chunk.data.toString('latin1', 0, nul)
    if (!wanted.has(keyword)) continue
    out[keyword] = chunk.data.toString('utf8', nul + 1)
  }
  return out
}

/**
 * Rewrites the image so that it carries exactly `entries` as `tEXt` chunks:
 * existing chunks with those keywords are dropped, and the new ones are
 * inserted right after IHDR (where other readers expect metadata).
 *
 * Every other chunk — including all image data — is preserved byte for byte.
 */
export function writeTextChunks(buffer, entries) {
  const replace = new Set(Object.keys(entries))
  const chunks = readChunks(buffer)
  const kept = chunks.filter((chunk) => {
    if (chunk.type !== 'tEXt') return true
    const nul = chunk.data.indexOf(0)
    if (nul < 0) return true
    return !replace.has(chunk.data.toString('latin1', 0, nul))
  })

  const additions = Object.entries(entries)
    .filter(([, value]) => typeof value === 'string')
    .map(([keyword, value]) => Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(value, 'utf8'),
    ]))

  // After IHDR: index 1 when IHDR is first (it always is in a valid PNG).
  const insertAt = kept.length > 0 && kept[0].type === 'IHDR' ? 1 : 0
  const ordered = [
    ...kept.slice(0, insertAt),
    ...additions.map((data) => ({ type: 'tEXt', data })),
    ...kept.slice(insertAt),
  ]

  return Buffer.concat([
    SIGNATURE,
    ...ordered.map((chunk) => encodeChunk(chunk.type, chunk.data)),
  ])
}

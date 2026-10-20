/**
 * Smoke tests for the pure modules (no DSH runtime needed):
 *   node test/smoke.mjs
 *
 * Fixtures come from the SillyTavern checkout this package lives in. Point
 * ST_ROOT at another checkout to reuse them elsewhere.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPng, readTextChunks, readChunks, writeTextChunks, crc32 } from '../lib/png.js'
import { normalizeEntry, normalizeBook, scanWorldInfo, parseRegexFromString, matchKeys, POSITION } from '../lib/worldinfo.js'
import { estimateTokens } from '../lib/tokens.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ST_ROOT = process.env.ST_ROOT ?? join(here, '..', '..', '..')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// ---- PNG ------------------------------------------------------------------

const png = readFileSync(join(ST_ROOT, 'default', 'content', 'default_Seraphina.png'))

test('detects PNG signature', () => {
  assert.equal(isPng(png), true)
  assert.equal(isPng(Buffer.from('not a png')), false)
})

test('crc32 matches the PNG specification vector', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082)
})

test('reads the chara card out of a real SillyTavern avatar', () => {
  const text = readTextChunks(png, ['chara', 'ccv3'])
  assert.ok(text.chara, 'expected a chara tEXt chunk')
  const card = JSON.parse(Buffer.from(text.chara, 'base64').toString('utf8'))
  assert.ok(card.name, 'card has a name')
  assert.ok(card.description, 'card has a description')
  console.log(`     card: ${card.name} / spec ${card.spec} ${card.spec_version} / fields ${Object.keys(card).length}`)
})

test('rewrites metadata without touching image data', () => {
  const before = readChunks(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data.toString('base64'))
  const rewritten = writeTextChunks(png, { chara: Buffer.from(JSON.stringify({ name: 'Renamed' }), 'utf8').toString('base64') })
  const after = readChunks(rewritten).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data.toString('base64'))
  assert.deepEqual(after, before)

  const card = JSON.parse(Buffer.from(readTextChunks(rewritten, ['chara']).chara, 'base64').toString('utf8'))
  assert.equal(card.name, 'Renamed')

  const again = writeTextChunks(rewritten, { chara: Buffer.from(JSON.stringify({ name: 'Third' }), 'utf8').toString('base64') })
  const charaChunks = readChunks(again).filter(
    (chunk) => chunk.type === 'tEXt' && chunk.data.toString('latin1', 0, chunk.data.indexOf(0)) === 'chara',
  )
  assert.equal(charaChunks.length, 1, 'the old chara chunk is replaced, not duplicated')
})

// ---- world info -----------------------------------------------------------

test('parses SillyTavern regex keys', () => {
  assert.ok(parseRegexFromString('/drag(on|ons)/i'))
  assert.equal(parseRegexFromString('plain'), null)
  assert.equal(parseRegexFromString('/a/b/'), null, 'unescaped inner slash is not a regex')
})

test('matches keys with case, whole-word and regex rules', () => {
  const entry = normalizeEntry({ key: ['Dragon'] }, 'book', 0)
  const globals = { caseSensitive: false, matchWholeWords: false }
  assert.equal(matchKeys('a dragon appears', 'Dragon', entry, globals), true)
  assert.equal(matchKeys('a dragonfly appears', 'Dragon', { ...entry, matchWholeWords: true }, globals), false)
  assert.equal(matchKeys('a DRAGON', '/dragon/i', entry, globals), true)
})

test('selective logic: AND_ANY / AND_ALL / NOT_ANY / NOT_ALL', () => {
  const make = (logic) => normalizeEntry({
    key: ['gate'],
    keysecondary: ['red', 'blue'],
    selective: true,
    selectiveLogic: logic,
  }, 'book', 0)

  const scan = (logic, text) => scanWorldInfo({
    books: [{ name: 'book', entries: { 0: make(logic) } }],
    messages: [{ role: 'user', text }],
    options: { scanDepth: 4, recursive: false },
  }).activated.length

  assert.equal(scan(0, 'gate red'), 1, 'AND_ANY: one secondary')
  assert.equal(scan(3, 'gate red'), 0, 'AND_ALL: needs both')
  assert.equal(scan(3, 'gate red blue'), 1, 'AND_ALL: both present')
  assert.equal(scan(2, 'gate green'), 1, 'NOT_ANY: no secondary present')
  assert.equal(scan(2, 'gate red'), 0, 'NOT_ANY: one present')
  assert.equal(scan(1, 'gate red'), 1, 'NOT_ALL: one absent')
  assert.equal(scan(1, 'gate red blue'), 0, 'NOT_ALL: none absent')
})

test('scan depth only sees the newest messages', () => {
  const book = normalizeBook({
    name: 'book',
    entries: { 0: { uid: 0, key: ['needle'], content: 'found' } },
  })
  const deep = scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text: 'needle' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }],
    options: { scanDepth: 1, recursive: false },
  })
  assert.equal(deep.activated.length, 0, 'older message is outside scan depth')

  const near = scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'user', text: 'needle' }],
    options: { scanDepth: 1, recursive: false },
  })
  assert.equal(near.activated.length, 1)
})

test('constant entries always fire and buckets keep insertion order', () => {
  const book = normalizeBook({
    name: 'book',
    entries: {
      0: { uid: 0, constant: true, content: 'second', order: 50, position: POSITION.before },
      1: { uid: 1, constant: true, content: 'first', order: 10, position: POSITION.before },
      2: { uid: 2, constant: true, content: 'after', order: 5, position: POSITION.after },
    },
  })
  const result = scanWorldInfo({ books: [book], messages: [], options: { recursive: false } })
  assert.equal(result.before, 'first\nsecond', 'ascending order inside a bucket')
  assert.equal(result.after, 'after')
})

test('token budget drops low-priority entries', () => {
  const entries = {}
  for (let i = 0; i < 5; i++) {
    entries[i] = { uid: i, constant: true, content: 'x'.repeat(400), order: 100 - i }
  }
  const book = normalizeBook({ name: 'book', entries })
  const result = scanWorldInfo({
    books: [book],
    messages: [],
    options: { recursive: false, maxContext: 1000, budgetPercent: 25 },
  })
  assert.ok(result.activated.length < 5, 'budget must cut entries')
  assert.equal(result.overflowed, true)
})

test('recursion activates an entry reachable only through another entry', () => {
  const book = normalizeBook({
    name: 'book',
    entries: {
      0: { uid: 0, key: ['sword'], content: 'The sword was forged by the Smiths of Orin.' },
      1: { uid: 1, key: ['Orin'], content: 'Orin is a lost city.' },
    },
  })
  const withoutRecursion = scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text: 'I draw my sword.' }],
    options: { scanDepth: 4, recursive: false },
  })
  assert.equal(withoutRecursion.activated.length, 1)

  const withRecursion = scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text: 'I draw my sword.' }],
    options: { scanDepth: 4, recursive: true, maxRecursionSteps: 3 },
  })
  assert.equal(withRecursion.activated.length, 2, 'second pass sees the first entry text')
})

test('sticky keeps an entry active beyond its trigger turn', () => {
  const book = normalizeBook({
    name: 'book',
    entries: { 0: { uid: 0, key: ['ambush'], content: 'Ambush!', sticky: 3 } },
  })
  const timed = { sticky: {}, cooldown: {} }
  const scan = (text, turn) => scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text }],
    options: { scanDepth: 4, recursive: false },
    turn,
    timed,
  })

  assert.equal(scan('ambush', 1).activated.length, 1, 'activates on the trigger turn')
  Object.assign(timed, scan('ambush', 1).timed)
  assert.equal(scan('nothing', 2).activated.length, 1, 'sticky keeps it on turn 2')
  Object.assign(timed, scan('nothing', 2).timed)
  assert.equal(scan('nothing', 3).activated.length, 1, 'still active on turn 3')
  Object.assign(timed, scan('nothing', 3).timed)
  assert.equal(scan('nothing', 4).activated.length, 0, 'expires at start + N')
})

test('group selection keeps exactly one member per group', () => {
  const book = normalizeBook({
    name: 'book',
    entries: {
      0: { uid: 0, constant: true, group: 'weather', content: 'rain', groupWeight: 1 },
      1: { uid: 1, constant: true, group: 'weather', content: 'sun', groupWeight: 1 },
    },
  })
  const result = scanWorldInfo({ books: [book], messages: [], options: { recursive: false }, rng: () => 0.99 })
  assert.equal(result.activated.length, 1)
})

test('token estimator separates CJK from latin', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens(''), 0)
})

test('reads a character-card character_book (array shape, string positions)', () => {
  const card = JSON.parse(Buffer.from(readTextChunks(png, ['ccv3', 'chara']).ccv3 ?? readTextChunks(png, ['chara']).chara, 'base64').toString('utf8'))
  if (!card?.data?.character_book) return
  const book = normalizeBook({ name: 'embedded', entries: card.data.character_book.entries })
  const entries = Object.values(book.entries)
  assert.ok(entries.length > 0)
  assert.ok(entries.every((entry) => Array.isArray(entry.key)))
  assert.ok(entries.every((entry) => entry.order === 100))
  assert.ok(entries.every((entry) => entry.position === 0), 'position came from extensions')
})

test('scans the shipped Eldoria lorebook', () => {
  const raw = JSON.parse(readFileSync(join(ST_ROOT, 'default', 'content', 'Eldoria.json'), 'utf8'))
  raw.name = 'Eldoria'
  const book = normalizeBook(raw)
  const result = scanWorldInfo({
    books: [book],
    messages: [{ role: 'user', text: 'I look around the city of Eldoria and ask about the Eldorian guard.' }],
    options: { scanDepth: 4, recursive: true, maxRecursionSteps: 3, maxContext: 8192, budgetPercent: 25 },
  })
  console.log(`     Eldoria entries: ${Object.keys(book.entries).length}, activated ${result.activated.length}`)
  assert.ok(result.activated.length > 0, 'a lorebook sentence should activate something')
})

console.log(`\n${passed} passed`)

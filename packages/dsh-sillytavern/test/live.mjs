/**
 * Talks to the running Host API the way the Web page does, so the composed
 * prompt can be inspected without a browser:
 *
 *   node test/live.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:60074'

async function get(path) {
  const response = await fetch(base + path)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-st-api': '1' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}

const state = await get('/st-api/state')
console.log('parts:', state.parts.join(', '))

const [characters, worlds, presets, personas] = await Promise.all([
  get('/st-api/characters'),
  get('/st-api/worlds'),
  get('/st-api/presets'),
  get('/st-api/personas'),
])
console.log('characters:', characters.characters.map((c) => c.name).join(', ') || '(none)')
console.log('worlds:', worlds.worlds.map((w) => `${w.name}(${w.entries})`).join(', ') || '(none)')
console.log('presets:', presets.presets.map((p) => p.name).join(', ') || '(none)')
console.log('personas:', personas.personas.map((p) => p.name).join(', ') || '(none)')

const character = characters.characters[0]
const world = worlds.worlds[0]
const preset = presets.presets[0]
const persona = personas.personas[0]
if (!character || !preset) {
  console.log('nothing composed yet: import a character and a preset first')
  process.exit(0)
}

const preview = await post('/st-api/preview', {
  characterId: character.id,
  worldbookIds: world ? [world.id] : [],
  presetId: preset.id,
  personaId: persona ? persona.id : undefined,
  sampleText: '我打量着四周，问起这里的传说。',
})
console.log(`\npreview: ${preview.system.length} chars, ${preview.activated.length} world entries activated, persona ${preview.persona}`)
console.log(preview.system.slice(0, 600))
console.log('...')

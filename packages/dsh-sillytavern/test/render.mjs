/**
 * Renders the Client half's components outside a browser, with a miniature
 * React (function components + the hooks the panels use) and a stubbed fetch.
 *
 * This is not a substitute for looking at the page; it exists to catch the
 * render-time failures a browser would show only after the user opens Settings:
 * undefined reads, `.map` on missing fields, wrong hook order, and so on.
 *
 *   node test/render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../client/index.js', import.meta.url)), 'utf8')

// ---- miniature React ------------------------------------------------------

const stores = new Map()
let hookCursor = 0
let currentHooks = []
const pendingEffects = []

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in currentHooks)) {
      currentHooks[index] = typeof initial === 'function' ? initial() : initial
    }
    const hooks = currentHooks
    return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
  },
  useEffect(effect, deps) {
    const index = hookCursor++
    const previous = currentHooks[index]
    if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
      currentHooks[index] = deps
      pendingEffects.push(effect)
    }
  },
  useCallback(fn, deps) {
    const index = hookCursor++
    const previous = currentHooks[index]
    if (!previous || !deps || deps.some((value, i) => value !== previous.deps[i])) {
      currentHooks[index] = { deps, fn }
    }
    return currentHooks[index].fn
  },
  useRef(initial) {
    const index = hookCursor++
    if (!(index in currentHooks)) currentHooks[index] = { current: initial }
    return currentHooks[index]
  },
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    const savedCursor = hookCursor
    const savedHooks = currentHooks
    hookCursor = 0
    currentHooks = stores.get(node.type) || []
    stores.set(node.type, currentHooks)
    const output = node.type({ ...node.props, children: node.children })
    hookCursor = savedCursor
    currentHooks = savedHooks
    return render(output)
  }
  if (node.type === React.Fragment) return render(node.children)
  return render(node.children)
}

// ---- stubbed browser ------------------------------------------------------

globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__loaded = definition } } }
globalThis.document = { createElement: () => ({ click() {} }) }
globalThis.TextDecoder = TextDecoder
globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary')

const characters = [{
  id: 'c1', name: 'Seraphina', creator: 'OtisAlejandro', tags: ['fantasy'], hasAvatar: true,
}]
const worlds = [{ id: 'w1', name: 'Eldoria', entries: 4 }]
const presets = [{ id: 'p1', name: 'Default', prompts: 12 }]

const responses = {
  '/st-api/state': { dataDir: 'C:/data', parts: ['characters', 'worldbook', 'presets'], defaults: { characterId: 'c1' }, sessions: 0 },
  '/st-api/characters': { characters },
  '/st-api/characters/c1': {
    character: {
      id: 'c1', name: 'Seraphina', creator: 'OtisAlejandro', spec: 'chara_card_v2',
      characterVersion: '1.0.0', tags: ['fantasy'], description: 'A guardian of the forest.',
      firstMes: 'You wake up.', alternateGreetings: ['Hello again.'],
    },
  },
  '/st-api/worlds': { worlds },
  '/st-api/worlds/w1': {
    world: {
      id: 'w1', name: 'Eldoria',
      entries: {
        0: { uid: 0, comment: 'eldoria', key: ['eldoria'], content: 'Eldoria is a forest.', order: 100 },
        1: { uid: 1, comment: 'guard', key: ['guard'], content: 'The guard watches.', order: 90 },
      },
    },
  },
  '/st-api/presets': { presets },
  '/st-api/presets/p1': {
    preset: {
      id: 'p1', name: 'Default', temperature: 1, topP: 1, maxTokens: 4096,
      prompts: [
        { identifier: 'main', name: 'Main Prompt', role: 'system', marker: false },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
      ],
      promptOrder: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: false }],
    },
  },
  '/st-api/sessions/session-1/binding': {
    characterId: 'c1', worldbookIds: ['w1'], presetId: 'p1', personaId: 'u1', greetingIndex: 0, sessionId: 'session-1',
  },
  '/st-api/personas': { personas: [{ id: 'u1', name: 'Ash', descriptionPreview: 'A traveller from the north.' }] },
  '/st-api/personas/u1': { persona: { id: 'u1', name: 'Ash', description: 'A traveller from the north.' } },
  '/st-api/preview': { system: 'Write Seraphina\'s next reply.', activated: [], depth: [] },
}

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  const body = responses[url]
  if (!body) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"no stub"}' }
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }
}

// ---- load the module ------------------------------------------------------

new Function('window', source)(globalThis.window)
const clientModule = globalThis.__loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected import ${name}`)
})

const registrations = []
clientModule.apply({
  effect(callback) {
    callback()
    return () => {}
  },
  locale: {
    register() {
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  slots: {
    inject(_key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ key: options.name, component })
      return () => {}
    },
  },
})

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

async function renderToText(component, props) {
  let output = ''
  for (let pass = 0; pass < 4; pass++) {
    pendingEffects.length = 0
    output = render({ type: component, props, children: [] })
    for (const effect of pendingEffects) effect()
    await settle()
  }
  return output
}

const settings = registrations.find((entry) => entry.key === 'settings.section')
const composer = registrations.find((entry) => entry.key === 'conversation.input.left')
const dock = registrations.find((entry) => entry.key === 'conversation.input.dock')
const overlay = registrations.find((entry) => entry.key === 'shell.overlay')
assert.ok(settings && composer && dock && overlay, 'all four surfaces register')

const page = await renderToText(settings.component, { t: (key) => key })
assert.ok(page.includes('characters'), 'the tab bar renders')
assert.ok(page.includes('Seraphina'), 'the character list renders with data')
assert.ok(page.includes('importFile'), 'the import control renders')

const composerText = await renderToText(composer.component, { t: (key) => key, sessionId: 'session-1' })
assert.ok(composerText.includes('Seraphina'), 'the composer control shows the bound character')

const dockText = await renderToText(dock.component, { t: (key) => key, sessionId: 'session-1' })
assert.ok(dockText.includes('Seraphina'), 'the conversation dock shows the bound character')
assert.ok(dockText.includes('openPanel'), 'the dock offers the panel button')

// Each settings tab also renders on its own, so a tab that only breaks when
// opened is still covered.
const components = clientModule.apply.__components || {}
assert.ok(Object.keys(components).length >= 4, 'the components are exposed for this test')
for (const [name, component] of Object.entries(components)) {
  if (name === 'LibraryPanel') continue
  const text = await renderToText(component, { t: (key) => key, sessionId: 'session-1' })
  assert.ok(text.length > 0, `${name} renders`)
}

// Opening the panel from the dock renders every library tab in place, which is
// the whole point of the conversation surface.
const panel = clientModule.apply.__panel
assert.ok(panel, 'the panel state is exposed for this test')
const panelContent = {
  characters: 'Seraphina',
  worlds: 'Eldoria',
  presets: 'Default',
  personas: 'addPersona',
}
for (const [tab, marker] of Object.entries(panelContent)) {
  panel.open = true
  panel.tab = tab
  panel.sessionId = 'session-1'
  const text = await renderToText(components.LibraryPanel, { t: (key) => key })
  assert.ok(text.includes('close'), `the ${tab} panel renders its chrome`)
  assert.ok(text.includes(marker), `the ${tab} panel renders its content (${marker})`)
}
panel.open = false
assert.equal(await renderToText(components.LibraryPanel, { t: (key) => key }), '', 'a closed panel renders nothing')

assert.ok(calls.length > 0, 'the panels fetched through the Host API')
console.log(`client render tests passed (${calls.length} API calls, ${page.length} chars)`)

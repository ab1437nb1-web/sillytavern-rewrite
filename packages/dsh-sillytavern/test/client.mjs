/**
 * Loads the Client half outside the browser: stubs `window.__ModuleLoader__`,
 * React (only createElement is exercised at registration time) and the Cordis
 * context, then checks that both surfaces register where DSH expects them.
 *
 *   node test/client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../client/index.js', import.meta.url)), 'utf8')

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

const React = {
  createElement(type, props, ...children) {
    return { type, props, children }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    return [initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial }
  },
}

// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

assert.equal(loaded.id, 'dsh-sillytavern', 'module id is the package name')
const module = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected import ${name}`)
})

assert.ok(module.apply, 'the client half exports apply')
assert.ok(Array.isArray(module.inject) && module.inject.includes('slots'), 'it injects slots')

const registered = []
const dictionaries = []
const ctx = {
  effect(callback) {
    callback()
    return () => {}
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts })
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
  slots: {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registered.push({ key: options.name, id: options.id, component })
      return () => {}
    },
  },
}

module.apply(ctx)

assert.deepEqual(
  registered.map((entry) => entry.key).sort(),
  ['conversation.input.dock', 'conversation.input.left', 'settings.section', 'shell.overlay'],
)
assert.ok(registered.every((entry) => typeof entry.component === 'function'), 'each registration has a component')
assert.equal(dictionaries.length, 1)
assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en, 'both dictionaries are registered')

// The settings page, the dock, the panel and the composer control must all be
// renderable in isolation. The panel renders nothing while closed, so open it.
const panel = module.apply.__panel
if (panel) {
  panel.open = true
  panel.sessionId = 'session-1'
  panel.tab = 'characters'
}

const t = (key) => key
for (const entry of registered) {
  const tree = entry.component({ t, sessionId: 'session-1' })
  assert.ok(tree && (tree.type === 'div' || typeof tree.type === 'function'), `${entry.key} renders a root element`)
}

// Every dictionary value must be a string: a function or object makes the
// locale service reject the registration, which previously failed the whole
// web boot.
for (const dictionary of dictionaries) {
  for (const [locale, dict] of Object.entries(dictionary.dicts)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is a string`)
    }
  }
}

// A hostile client runtime — locale missing, registration throwing — must
// degrade to "no panel" rather than failing the boot of the whole app.
const hostile = {
  effect() {
    throw new Error('effect unavailable')
  },
  slots: {
    inject() {
      throw new Error('slot not declared')
    },
    register() {
      throw new Error('register unavailable')
    },
  },
}
assert.doesNotThrow(() => module.apply(hostile), 'apply survives a broken client runtime')
assert.doesNotThrow(() => module.apply({ effect() { throw new Error('x') }, slots: { inject() { throw new Error('y') } } }), 'apply survives a missing locale')

console.log('client smoke tests passed')

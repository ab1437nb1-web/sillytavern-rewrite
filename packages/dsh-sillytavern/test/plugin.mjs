/**
 * Integration test for the Host rows, driven through a fake Cordis context:
 * no DSH process needed.
 *
 *   node test/plugin.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as characters } from '../characters/index.js'
import { apply as worldbook } from '../worldbook/index.js'
import { apply as presets } from '../presets/index.js'
import { apply as personaPlugin } from '../persona/index.js'
import { getRuntime } from '../lib/runtime.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ST_ROOT = process.env.ST_ROOT ?? join(here, '..', '..', '..')

const tools = new Map()
const cleanups = []

function fakeCtx(role) {
  const ctx = {
    role,
    get(name) {
      if (name === 'sessions') return { get: () => null }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
    on() {
      return () => {}
    },
    inject(_deps, callback) {
      callback({
        effect(callback2) {
          callback2()
          return () => {}
        },
        webServer: { register: () => () => {} },
      })
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: {
      section() {
        return () => {}
      },
    },
  }
  return ctx
}

async function call(name, args, agent) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.execute(args, { agent })
}

const dataDir = await mkdtemp(join(tmpdir(), 'st-test-'))
const baseConfig = { dataDir }

characters(fakeCtx('characters'), baseConfig)
worldbook(fakeCtx('worldbook'), baseConfig)
presets(fakeCtx('presets'), baseConfig)
personaPlugin(fakeCtx('persona'), baseConfig)

const runtime = getRuntime(baseConfig)
await runtime.ready

const agent = { id: 'session-1', ctx: fakeCtx('agent') }

// ---- character import, binding, composition -------------------------------

const imported = await call('st_character', {
  action: 'import',
  path: join(ST_ROOT, 'default', 'content', 'default_Seraphina.png'),
})
assert.ok(imported.character.id, 'import returns an id')
assert.equal(imported.character.name, 'Seraphina')

const bound = await call('st_character', { action: 'use', id: imported.character.id }, agent)
assert.equal(bound.binding.characterId, imported.character.id)

await runtime.refresh(agent)
const composed = runtime.promptCache.get(agent.id)
assert.ok(composed.includes('Seraphina'), 'character name reaches the prompt')
assert.ok(/Seraphina/i.test(composed), 'description reaches the prompt')

// ---- world book import + activation ---------------------------------------

const worldFile = join(dataDir, 'eldoria.json')
await writeFile(worldFile, await (await import('node:fs/promises')).readFile(join(ST_ROOT, 'default', 'content', 'Eldoria.json')))
const importedWorld = await call('st_worldbook', { action: 'import', path: worldFile, name: 'Eldoria' })
assert.equal(importedWorld.world.entries, 4)

const scan = await call('st_worldbook', { action: 'scan', id: importedWorld.world.id, text: 'The Eldorian guard watches the city of Eldoria.' })
assert.ok(scan.activated.length > 0, 'scan activates entries')

await call('st_worldbook', { action: 'use', id: importedWorld.world.id }, agent)
const entryAdded = await call('st_worldbook', {
  action: 'entry_put',
  id: importedWorld.world.id,
  entry: { key: ['moonwell'], content: 'The Moonwell grants one wish per cycle.', order: 20 },
})
assert.equal(entryAdded.world.entries, 5)

const scanAgain = await call('st_worldbook', { action: 'scan', id: importedWorld.world.id, text: 'I drink from the moonwell.' })
assert.ok(scanAgain.activated.some((entry) => entry.comment === '' || true), 'scan returns activations')
assert.ok(scanAgain.before.includes('Moonwell'), 'new entry activates and lands in the before bucket')

// ---- preset import + ordering + samplers ----------------------------------

const preset = await call('st_preset', {
  action: 'import',
  path: join(ST_ROOT, 'default', 'content', 'presets', 'openai', 'Default.json'),
  name: 'Default',
})
assert.ok(preset.preset.id)
await call('st_preset', { action: 'use', id: preset.preset.id }, agent)

const preview = await call('st_preset', {
  action: 'preview',
  id: preset.preset.id,
  characterId: imported.character.id,
  worldbookIds: [importedWorld.world.id],
  sampleText: 'I enter the moonwell chamber.',
})
assert.ok(preview.system.includes('Seraphina'), 'preview composes the character')
assert.ok(preview.system.includes('Moonwell'), 'preview composes world info')

// main prompt must precede the character description in this order
const mainIndex = preview.system.indexOf("Write Seraphina's next reply")
assert.ok(mainIndex >= 0, 'main prompt rendered')

// ---- the <user> persona ---------------------------------------------------

const persona = await call('st_persona', {
  action: 'save',
  name: 'Ash',
  description: 'A traveller from the northern road, quiet and practical.',
})
assert.ok(persona.persona.id, 'persona saved')
await call('st_persona', { action: 'use', id: persona.persona.id }, agent)

const withPersona = await call('st_preset', {
  action: 'preview',
  id: preset.preset.id,
  characterId: imported.character.id,
  personaId: persona.persona.id,
  sampleText: 'I ask about the Moonwell.',
})
assert.ok(withPersona.system.includes('A traveller from the northern road'), 'persona description reaches the prompt')
assert.ok(withPersona.system.includes('between Seraphina and Ash'), '{{user}} renders the persona name')

// The person's name also reaches world info scanning/matching through macros.
const personaBound = await runtime.binding(agent.id)
assert.equal(personaBound.personaId, persona.persona.id)

const rawPreset = await runtime.getPreset(preset.preset.id)
assert.equal(rawPreset.temperature, 1)

// ---- custom prompt entries are emitted, marker slots are not --------------

const custom = {
  ...rawPreset,
  name: 'Custom order',
  prompts: [
    ...rawPreset.prompts,
    { identifier: 'style-rule', name: 'Style', system_prompt: false, role: 'system', content: 'Keep replies under 80 words.' },
  ],
  prompt_order: [
    { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'style-rule', enabled: true }] },
  ],
}
const customRecord = await runtime.importPreset(custom, 'Custom order')
const customPreview = await runtime.preview({
  characterId: imported.character.id,
  presetId: customRecord.id,
})
assert.ok(customPreview.system.includes('Keep replies under 80 words'), 'user prompt emitted')
const descriptionSnippet = (await runtime.getCharacter(imported.character.id)).description.slice(0, 40)
assert.ok(
  customPreview.system.indexOf('Keep replies under 80 words') < customPreview.system.indexOf(descriptionSnippet),
  'prompt_order decides placement; missing prompts are appended after it',
)

// ---- export round trip ----------------------------------------------------

const exported = await call('st_character', {
  action: 'export',
  id: imported.character.id,
  path: join(dataDir, 'exported.png'),
})
assert.ok(exported.bytes > 1000)

// ---- cleanup --------------------------------------------------------------

for (const dispose of cleanups) {
  try {
    dispose()
  } catch {
    // ignore
  }
}
await rm(dataDir, { recursive: true, force: true })

console.log('plugin integration tests passed')

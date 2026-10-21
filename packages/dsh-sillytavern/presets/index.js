/**
 * st-presets — chat-completion presets: the prompt manager (which system
 * entries are emitted, in what order) plus the sampler settings a bound preset
 * contributes to the model request.
 */
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import { getRuntime } from '../lib/runtime.js'
import { jsonTool, objectSchema, str, num } from '../lib/tooling.js'

export const name = 'st-presets'
export const inject = ['tools', 'systemPrompt', 'sessions']

const ACTIONS = ['list', 'get', 'import', 'delete', 'use', 'unuse', 'default', 'preview']

function absolute(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function apply(ctx, config = {}) {
  const runtime = getRuntime(config)
  runtime.attach('presets', ctx, config)
  ctx.effect(() => () => runtime.detach('presets'))

  ctx.tools.register(jsonTool({
    name: 'st_preset',
    description: [
      'Manage SillyTavern chat-completion presets and which preset the current session uses.',
      'A preset controls the prompt-manager order of system entries (main prompt, world info, character fields, examples, jailbreak) and the sampler settings sent with each request.',
      'Actions: list, get, import, delete, use (bind to this session), unuse, default, preview (compose the prompt without a live session).',
    ].join(' '),
    parameters: objectSchema({
      action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
      id: str('Preset id from list/get.'),
      path: str('Path to a SillyTavern chat-completion preset JSON file (import).'),
      name: str('Preset name override on import.'),
      sessionId: str('Target session for use/unuse; defaults to the calling session.'),
      sampleText: str('Sample user text for preview.'),
      characterId: str('Character id for preview.'),
      personaId: str('Persona id for preview.'),
      worldbookIds: { type: 'array', items: { type: 'string' }, description: 'World ids for preview.' },
      temperature: num('Override the preset temperature before previewing.'),
    }, ['action']),
    handler: async (args, exec) => {
      const sessionId = args.sessionId ?? exec?.agent?.id
      switch (args.action) {
        case 'list':
          return { presets: await runtime.listPresets() }
        case 'get': {
          const preset = await runtime.getPreset(args.id)
          if (!preset) throw new Error(`unknown preset "${args.id}"`)
          return { preset }
        }
        case 'import': {
          if (!args.path) throw new Error('import needs path')
          const raw = JSON.parse(await readFile(absolute(args.path), 'utf8'))
          const record = await runtime.importPreset(raw, args.name ?? basename(args.path, '.json'))
          return { preset: { id: record.id, name: record.name, prompts: record.prompts?.length ?? 0 } }
        }
        case 'delete':
          await runtime.deletePreset(args.id)
          return { ok: true, id: args.id }
        case 'use': {
          if (!sessionId) throw new Error('use needs a session')
          const binding = await runtime.setBinding(sessionId, { presetId: args.id })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding }
        }
        case 'unuse': {
          if (!sessionId) throw new Error('unuse needs a session')
          const binding = await runtime.setBinding(sessionId, { presetId: null })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding }
        }
        case 'default':
          return { defaults: (await runtime.setBinding(null, { presetId: args.id })).defaults }
        case 'preview': {
          const result = await runtime.preview({
            characterId: args.characterId,
            worldbookIds: args.worldbookIds ?? [],
            presetId: args.id,
            personaId: args.personaId,
            sampleText: args.sampleText ?? '',
          })
          return result
        }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    },
  }))
}

/**
 * st-persona — the `<user>` identity: who the human is in the role-play.
 *
 * A persona contributes its name (the `{{user}}` macro in character cards and
 * world info) and its description (the preset's `personaDescription` slot).
 */
import { getRuntime } from '../lib/runtime.js'
import { jsonTool, objectSchema, str } from '../lib/tooling.js'

export const name = 'st-persona'
export const inject = ['tools', 'systemPrompt', 'sessions']

const ACTIONS = ['list', 'get', 'save', 'delete', 'use', 'unuse', 'default']

export function apply(ctx, config = {}) {
  const runtime = getRuntime(config)
  runtime.attach('persona', ctx, config)
  ctx.effect(() => () => runtime.detach('persona'))

  ctx.tools.register(jsonTool({
    name: 'st_persona',
    description: [
      'Manage the persona of the human in this conversation (SillyTavern\'s <user>).',
      'The persona name becomes the {{user}} macro; its description renders at the preset position "Persona Description".',
      'Actions: list, get, save (create or update), delete, use (bind to this session), unuse, default (bind every session).',
    ].join(' '),
    parameters: objectSchema({
      action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
      id: str('Persona id for get/delete/save(update)/use.'),
      name: str('Persona name, used as the {{user}} macro.'),
      description: str('Persona description injected into the prompt.'),
      sessionId: str('Target session for use/unuse; defaults to the calling session.'),
    }, ['action']),
    handler: async (args, exec) => {
      const sessionId = args.sessionId ?? exec?.agent?.id
      switch (args.action) {
        case 'list':
          return { personas: await runtime.listPersonas() }
        case 'get': {
          const persona = await runtime.getPersona(args.id)
          if (!persona) throw new Error(`unknown persona "${args.id}"`)
          return { persona }
        }
        case 'save': {
          const persona = await runtime.savePersona({ id: args.id, name: args.name, description: args.description })
          return { persona }
        }
        case 'delete':
          await runtime.deletePersona(args.id)
          return { ok: true, id: args.id }
        case 'use': {
          if (!sessionId) throw new Error('use needs a session')
          const binding = await runtime.setBinding(sessionId, { personaId: args.id })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding }
        }
        case 'unuse': {
          if (!sessionId) throw new Error('unuse needs a session')
          return { binding: await runtime.setBinding(sessionId, { personaId: null }) }
        }
        case 'default':
          return { defaults: (await runtime.setBinding(null, { personaId: args.id })).defaults }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    },
  }))
}

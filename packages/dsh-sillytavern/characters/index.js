/**
 * st-characters — the character-card library: import PNG/JSON/CHARX cards,
 * browse them, bind one to a session, export, and delete.
 *
 * The prompt text is produced by the shared runtime (see lib/runtime.js), so
 * this row only owns its library operations and their agent-facing tool.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import { greetingsOf } from '../lib/card.js'
import { getRuntime } from '../lib/runtime.js'
import { jsonTool, objectSchema, str } from '../lib/tooling.js'

export const name = 'st-characters'
export const inject = ['tools', 'systemPrompt', 'sessions']

const ACTIONS = ['list', 'get', 'import', 'export', 'delete', 'use', 'unuse', 'default', 'greeting']

function absolute(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function apply(ctx, config = {}) {
  const runtime = getRuntime(config)
  runtime.attach('characters', ctx, config)
  ctx.effect(() => () => runtime.detach('characters'))

  ctx.tools.register(jsonTool({
    name: 'st_character',
    description: [
      'Manage the SillyTavern character-card library and which card the current session plays as.',
      'A bound card contributes its description, personality, scenario and dialogue examples to the system prompt.',
      'Actions: list, get, import, export, delete, use (bind to this session), unuse, default (bind every session), greeting.',
    ].join(' '),
    parameters: objectSchema({
      action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
      id: str('Character id from a previous list/get call.'),
      path: str('Absolute or workspace-relative file path for import/export.'),
      format: { type: 'string', enum: ['png', 'json'], description: 'Export format (default png).' },
      sessionId: str('Target session for use/unuse; defaults to the calling session.'),
    }, ['action']),
    handler: async (args, exec) => {
      const sessionId = args.sessionId ?? exec?.agent?.id
      switch (args.action) {
        case 'list':
          return { characters: await runtime.listCharacters() }
        case 'get': {
          const card = await runtime.getCharacter(args.id)
          if (!card) throw new Error(`unknown character "${args.id}"`)
          return { character: card }
        }
        case 'import': {
          if (!args.path) throw new Error('import needs path')
          const buffer = await readFile(absolute(args.path))
          const record = await runtime.importCharacter(buffer, basename(args.path))
          return { character: record }
        }
        case 'export': {
          if (!args.path) throw new Error('export needs path')
          const result = await runtime.exportCharacter(args.id, args.format ?? 'png')
          await writeFile(absolute(args.path), result.buffer)
          return { path: absolute(args.path), bytes: result.buffer.length, contentType: result.contentType }
        }
        case 'delete':
          await runtime.deleteCharacter(args.id)
          return { ok: true, id: args.id }
        case 'use': {
          if (!sessionId) throw new Error('use needs a session')
          const binding = await runtime.setBinding(sessionId, { characterId: args.id })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding }
        }
        case 'unuse': {
          if (!sessionId) throw new Error('unuse needs a session')
          return { binding: await runtime.setBinding(sessionId, { characterId: null }) }
        }
        case 'default':
          return { defaults: (await runtime.setBinding(null, { characterId: args.id })).defaults }
        case 'greeting': {
          const card = await runtime.getCharacter(args.id)
          if (!card) throw new Error(`unknown character "${args.id}"`)
          const greetings = greetingsOf(card)
          return { greetings, firstMessage: greetings[0] ?? '' }
        }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    },
  }))
}

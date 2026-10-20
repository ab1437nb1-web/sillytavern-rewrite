/**
 * st-worldbook — the World Info (lorebook) library and its activation engine.
 *
 * Entries activate from recent conversation text using SillyTavern's rules
 * (keywords, secondary keys, recursion, sticky/cooldown, budget); the resulting
 * buckets are composed into the prompt by the shared runtime.
 */
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import { getRuntime } from '../lib/runtime.js'
import { jsonTool, objectSchema, num, str, arr } from '../lib/tooling.js'

export const name = 'st-worldbook'
export const inject = ['tools', 'systemPrompt', 'sessions']

const ACTIONS = ['list', 'get', 'import', 'delete', 'use', 'unuse', 'default', 'entry_put', 'entry_delete', 'scan']

function absolute(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function apply(ctx, config = {}) {
  const runtime = getRuntime(config)
  runtime.attach('worldbook', ctx, config)
  ctx.effect(() => () => runtime.detach('worldbook'))

  ctx.tools.register(jsonTool({
    name: 'st_worldbook',
    description: [
      'Manage SillyTavern World Info (lorebook) libraries and which books the current session uses.',
      'Activated entries are injected into the system prompt before and after the character description.',
      'Actions: list, get, import, delete, use (add to this session), unuse, default, entry_put, entry_delete, scan (test activation against sample text).',
    ].join(' '),
    parameters: objectSchema({
      action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
      id: str('World id from list/get.'),
      path: str('Path to a SillyTavern world info JSON file (import).'),
      name: str('Book name override on import.'),
      sessionId: str('Target session for use/unuse; defaults to the calling session.'),
      text: str('Sample conversation text for scan.'),
      uid: num('Entry id for entry_put / entry_delete.'),
      entry: {
        type: 'object',
        description: 'Entry fields to merge: key, keysecondary, content, constant, order, position, depth, role, disable, probability, sticky, cooldown, delay, selective, selectiveLogic, group, groupWeight, scanDepth, caseSensitive, matchWholeWords, comment.',
        additionalProperties: true,
      },
      depth: num('Scan depth override for scan.'),
    }, ['action']),
    handler: async (args, exec) => {
      const sessionId = args.sessionId ?? exec?.agent?.id
      switch (args.action) {
        case 'list':
          return { worlds: await runtime.listWorlds() }
        case 'get': {
          const world = await runtime.getWorld(args.id)
          if (!world) throw new Error(`unknown world "${args.id}"`)
          return { world }
        }
        case 'import': {
          if (!args.path) throw new Error('import needs path')
          const raw = JSON.parse(await readFile(absolute(args.path), 'utf8'))
          const record = await runtime.importWorld(raw, args.name ?? basename(args.path, '.json'))
          return { world: { id: record.id, name: record.name, entries: Object.keys(record.entries ?? {}).length } }
        }
        case 'delete':
          await runtime.deleteWorld(args.id)
          return { ok: true, id: args.id }
        case 'use': {
          if (!sessionId) throw new Error('use needs a session')
          const binding = await runtime.binding(sessionId)
          const ids = [...new Set([...(binding.worldbookIds ?? []), args.id])]
          const next = await runtime.setBinding(sessionId, { worldbookIds: ids })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding: next }
        }
        case 'unuse': {
          if (!sessionId) throw new Error('unuse needs a session')
          const binding = await runtime.binding(sessionId)
          const ids = (binding.worldbookIds ?? []).filter((id) => id !== args.id)
          const next = await runtime.setBinding(sessionId, { worldbookIds: ids })
          const agent = runtime.agentRefs.get(sessionId)
          if (agent) await runtime.refresh(agent)
          return { binding: next }
        }
        case 'default': {
          const current = await runtime.binding(null)
          const ids = [...new Set([...(current.worldbookIds ?? []), args.id])]
          const next = await runtime.setBinding(null, { worldbookIds: ids })
          for (const agent of runtime.agentRefs.values()) await runtime.refresh(agent)
          return { defaults: next.defaults }
        }
        case 'entry_put': {
          const world = await runtime.putWorldEntry(args.id, args.uid, args.entry ?? {})
          const agent = sessionId ? runtime.agentRefs.get(sessionId) : undefined
          if (agent) await runtime.refresh(agent)
          return { world: { id: world.id, name: world.name, entries: Object.keys(world.entries ?? {}).length } }
        }
        case 'entry_delete': {
          const world = await runtime.deleteWorldEntry(args.id, args.uid)
          return { world: { id: world.id, name: world.name, entries: Object.keys(world.entries ?? {}).length } }
        }
        case 'scan': {
          const scan = await runtime.testWorld(args.id, args.text ?? '', { scanDepth: args.depth })
          return {
            before: scan.before,
            after: scan.after,
            activated: scan.activated,
            overflowed: scan.overflowed,
            passes: scan.passes,
          }
        }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
    },
  }))
}

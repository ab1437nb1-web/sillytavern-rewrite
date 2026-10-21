/**
 * The Host HTTP surface behind the Web GUI pages and the session composer
 * control. One prefix route, JSON in / JSON out, mounted by whichever row is
 * the runtime leader.
 *
 * Every request must carry `x-st-api: 1`. A cross-origin page cannot add that
 * header without a CORS preflight, which this route never answers, so the
 * custom header is the route's CSRF guard.
 */
const PREFIX = '/st-api'
const HEADER = 'x-st-api'

function send(response, status, body, contentType = 'application/json') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

function readBody(request, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function decodeBase64(value) {
  const text = String(value ?? '')
  const comma = text.indexOf(',')
  const body = comma >= 0 && text.startsWith('data:') ? text.slice(comma + 1) : text
  return Buffer.from(body, 'base64')
}

/**
 * @param {import('./runtime.js').Runtime} runtime
 * @param {(ctx: object) => void} register receives a function that installs the route
 */
export function mountApi(runtime, ctx, server) {
  return server.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== '1' && request.method !== 'GET') {
        send(response, 403, { error: 'missing request header' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean)
      const method = request.method ?? 'GET'

      try {
        await route(runtime, segments, method, url, request, response)
      } catch (error) {
        send(response, 400, { error: error?.message ?? String(error) })
      }
    },
  })
}

async function route(runtime, segments, method, url, request, response) {
  const [root, ...rest] = segments

  if (root === 'state' && method === 'GET') {
    const state = await runtime.store.state()
    send(response, 200, {
      dataDir: runtime.dataDir,
      parts: [...runtime.parts.keys()],
      defaults: state.defaults ?? {},
      sessions: Object.keys(state.sessions ?? {}).length,
    })
    return
  }

  if (root === 'characters') {
    if (rest.length === 0 && method === 'GET') {
      send(response, 200, { characters: await runtime.listCharacters() })
      return
    }
    if (rest[0] === 'import' && method === 'POST') {
      const body = await readBody(request)
      const buffer = body.base64 ? decodeBase64(body.base64) : Buffer.from(body.json ?? '', 'utf8')
      const record = await runtime.importCharacter(buffer, body.filename ?? '')
      send(response, 200, { character: record })
      return
    }
    if (rest.length === 1 && method === 'GET') {
      const card = await runtime.getCharacter(rest[0])
      if (!card) return send(response, 404, { error: 'unknown character' })
      send(response, 200, { character: card })
      return
    }
    if (rest.length === 1 && method === 'DELETE') {
      await runtime.deleteCharacter(rest[0])
      send(response, 200, { ok: true })
      return
    }
    if (rest.length === 2 && rest[1] === 'avatar' && method === 'GET') {
      const png = await runtime.store.readBytes('characters', rest[0], 'png')
      if (!png) return send(response, 404, { error: 'no avatar' })
      send(response, 200, png, 'image/png')
      return
    }
    if (rest.length === 2 && rest[1] === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'png'
      const result = await runtime.exportCharacter(rest[0], format)
      send(response, 200, result.buffer, result.contentType)
      return
    }
  }

  if (root === 'worlds') {
    if (rest.length === 0 && method === 'GET') {
      send(response, 200, { worlds: await runtime.listWorlds() })
      return
    }
    if (rest[0] === 'import' && method === 'POST') {
      const body = await readBody(request)
      const raw = body.json ? JSON.parse(body.json) : body.data
      const record = await runtime.importWorld(raw, body.name)
      send(response, 200, { world: record })
      return
    }
    if (rest.length === 1 && method === 'GET') {
      const world = await runtime.getWorld(rest[0])
      if (!world) return send(response, 404, { error: 'unknown world' })
      send(response, 200, { world })
      return
    }
    if (rest.length === 1 && method === 'DELETE') {
      await runtime.deleteWorld(rest[0])
      send(response, 200, { ok: true })
      return
    }
    if (rest.length === 2 && rest[1] === 'scan' && method === 'POST') {
      const body = await readBody(request)
      send(response, 200, await runtime.testWorld(rest[0], body.text ?? ''))
      return
    }
    if (rest.length === 3 && rest[1] === 'entries') {
      if (method === 'PUT') {
        const body = await readBody(request)
        const world = await runtime.putWorldEntry(rest[0], rest[2], body ?? {})
        send(response, 200, { world })
        return
      }
      if (method === 'DELETE') {
        const world = await runtime.deleteWorldEntry(rest[0], rest[2])
        send(response, 200, { world })
        return
      }
    }
  }

  if (root === 'presets') {
    if (rest.length === 0 && method === 'GET') {
      send(response, 200, { presets: await runtime.listPresets() })
      return
    }
    if (rest[0] === 'import' && method === 'POST') {
      const body = await readBody(request)
      const raw = body.json ? JSON.parse(body.json) : body.data
      const record = await runtime.importPreset(raw, body.name)
      send(response, 200, { preset: record })
      return
    }
    if (rest.length === 1 && method === 'GET') {
      const preset = await runtime.getPreset(rest[0])
      if (!preset) return send(response, 404, { error: 'unknown preset' })
      send(response, 200, { preset })
      return
    }
    if (rest.length === 1 && method === 'DELETE') {
      await runtime.deletePreset(rest[0])
      send(response, 200, { ok: true })
      return
    }
  }

  if (root === 'personas') {
    if (rest.length === 0 && method === 'GET') {
      send(response, 200, { personas: await runtime.listPersonas() })
      return
    }
    if (rest.length === 0 && method === 'POST') {
      const body = await readBody(request)
      send(response, 200, { persona: await runtime.savePersona(body ?? {}) })
      return
    }
    if (rest.length === 1 && method === 'GET') {
      const persona = await runtime.getPersona(rest[0])
      if (!persona) return send(response, 404, { error: 'unknown persona' })
      send(response, 200, { persona })
      return
    }
    if (rest.length === 1 && method === 'DELETE') {
      await runtime.deletePersona(rest[0])
      send(response, 200, { ok: true })
      return
    }
  }

  if (root === 'preview' && method === 'POST') {
    const body = await readBody(request)
    send(response, 200, await runtime.preview(body ?? {}))
    return
  }

  if (root === 'sessions' && rest.length === 2 && rest[1] === 'binding') {
    if (method === 'GET') {
      send(response, 200, await runtime.binding(rest[0]))
      return
    }
    if (method === 'POST') {
      const body = await readBody(request)
      const binding = await runtime.setBinding(rest[0], body ?? {})
      const agent = runtime.agentRefs.get(rest[0])
      if (agent) await runtime.refresh(agent)
      send(response, 200, { binding })
      return
    }
  }

  if (root === 'defaults' && method === 'POST') {
    const body = await readBody(request)
    const binding = await runtime.setBinding(null, body ?? {})
    for (const agent of runtime.agentRefs.values()) await runtime.refresh(agent)
    send(response, 200, { binding })
    return
  }

  send(response, 404, { error: `no route for ${method} ${url.pathname}` })
}

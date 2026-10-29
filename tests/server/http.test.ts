/**
 * Server contract: HTTP endpoints that don't need tmux (info, config,
 * prompt, tiles, CORS, static files).
 *
 * Run against another implementation with VIBECRAFT_SERVER_CMD=<command>.
 */

import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { createTestEnv, REPO_ROOT, type TestEnv } from '../helpers/env.ts'
import { ALLOWED_ORIGIN, connectClient, getJson, sendJson, startServer, type TestServer } from '../helpers/server.ts'

/** Raw GET, so paths like /%2e%2e/ reach the server unnormalized */
function rawGet(server: TestServer, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolveRes, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolveRes({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('server: read-only endpoints', () => {
  let env: TestEnv
  let server: TestServer
  before(async () => { env = createTestEnv(); server = await startServer(env, { USER: 'tester' }) })
  after(async () => { await server.stop(); env.cleanup() })

  it('/health', async () => {
    const { status, body } = await getJson(server, '/health')
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(body).sort(), ['clients', 'events', 'ok', 'version', 'voiceEnabled'])
    assert.equal(body.ok, true)
    assert.equal(body.voiceEnabled, false)
    assert.equal(typeof body.version, 'string')
  })

  it('/config', async () => {
    assert.deepEqual((await getJson(server, '/config')).body, {
      username: 'tester', hostname: hostname(), tmuxSession: 'vibecraft-test-none',
    })
  })

  it('/info returns the server cwd', async () => {
    assert.deepEqual((await getJson(server, '/info')).body, { ok: true, cwd: REPO_ROOT })
  })

  it('/stats on an empty server', async () => {
    assert.deepEqual((await getJson(server, '/stats')).body, { totalEvents: 0, toolCounts: {}, avgDurations: {}, tokens: {} })
  })

  it('/sessions is empty', async () => {
    assert.deepEqual((await getJson(server, '/sessions')).body, { ok: true, sessions: [] })
  })

  it('/projects is empty', async () => {
    assert.deepEqual((await getJson(server, '/projects')).body, { ok: true, projects: [] })
  })
})

describe('server: CORS', () => {
  let env: TestEnv
  let server: TestServer
  before(async () => { env = createTestEnv(); server = await startServer(env) })
  after(async () => { await server.stop(); env.cleanup() })

  it('echoes allowed origins', async () => {
    const res = await fetch(`${server.url}/health`, { headers: { Origin: ALLOWED_ORIGIN } })
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS')
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type')
  })

  it('omits CORS headers for other origins', async () => {
    const res = await fetch(`${server.url}/health`, { headers: { Origin: 'http://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('preflight: 204 for allowed origins, 403 otherwise', async () => {
    const ok = await fetch(`${server.url}/event`, { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN } })
    assert.equal(ok.status, 204)
    const bad = await fetch(`${server.url}/event`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } })
    assert.equal(bad.status, 403)
    const none = await fetch(`${server.url}/event`, { method: 'OPTIONS' })
    assert.equal(none.status, 403)
  })
})

describe('server: pending prompt', () => {
  let env: TestEnv
  let server: TestServer
  beforeEach(async () => { env = createTestEnv(); server = await startServer(env) })
  afterEach(async () => { await server.stop(); env.cleanup() })

  it('save, read and clear without sending to tmux', async () => {
    const file = join(env.dataDir, 'pending-prompt.txt')
    assert.deepEqual((await getJson(server, '/prompt')).body, { prompt: null })

    const saved = await sendJson(server, 'POST', '/prompt', { prompt: 'faça X' })
    assert.deepEqual(saved, { status: 200, body: { ok: true, saved: file } })
    assert.equal(readFileSync(file, 'utf-8'), 'faça X')
    assert.deepEqual((await getJson(server, '/prompt')).body, { prompt: 'faça X', file })

    assert.deepEqual(await sendJson(server, 'DELETE', '/prompt'), { status: 200, body: { ok: true } })
    assert.equal(existsSync(file), false)
    assert.deepEqual((await getJson(server, '/prompt')).body, { prompt: null })
  })

  it('send=true reports the tmux failure but still saves', async () => {
    const res = await sendJson(server, 'POST', '/prompt', { prompt: 'p', send: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.sent, false)
    assert.equal(typeof res.body.tmuxError, 'string')
  })

  it('validates input', async () => {
    assert.deepEqual(await sendJson(server, 'POST', '/prompt', {}), { status: 400, body: { error: 'Prompt is required' } })
    assert.deepEqual(await sendJson(server, 'POST', '/prompt', { prompt: 3 }), { status: 400, body: { error: 'Prompt is required' } })
    assert.deepEqual(await sendJson(server, 'POST', '/prompt', '{x'), { status: 400, body: { error: 'Invalid JSON' } })
  })
})

describe('server: text tiles', () => {
  let env: TestEnv
  let server: TestServer | null
  beforeEach(async () => { env = createTestEnv(); server = await startServer(env) })
  afterEach(async () => { await server?.stop(); env.cleanup() })

  it('create, update, delete, with broadcasts', async () => {
    const client = await connectClient(server!)
    await client.next('history')

    const created = await sendJson(server!, 'POST', '/tiles', { text: 'Olá', position: { q: 1, r: -2 }, color: '#ff0000' })
    assert.equal(created.status, 201)
    const tile = created.body.tile
    assert.match(tile.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual({ ...tile, id: undefined, createdAt: undefined }, {
      id: undefined, createdAt: undefined, text: 'Olá', position: { q: 1, r: -2 }, color: '#ff0000',
    })
    assert.deepEqual((await client.next('text_tiles')).payload, [tile])

    const updated = await sendJson(server!, 'PUT', `/tiles/${tile.id}`, { text: 'Novo' })
    assert.deepEqual(updated, { status: 200, body: { ok: true, tile: { ...tile, text: 'Novo' } } })
    assert.deepEqual((await client.next('text_tiles')).payload, [{ ...tile, text: 'Novo' }])
    assert.deepEqual((await getJson(server!, '/tiles')).body, { ok: true, tiles: [{ ...tile, text: 'Novo' }] })

    assert.deepEqual(await sendJson(server!, 'DELETE', `/tiles/${tile.id}`), { status: 200, body: { ok: true } })
    assert.deepEqual((await client.next('text_tiles')).payload, [])
    client.close()
  })

  it('persists tiles across restarts', async () => {
    const { body } = await sendJson(server!, 'POST', '/tiles', { text: 'keep', position: { q: 0, r: 0 } })
    await server!.stop()
    server = await startServer(env)
    assert.deepEqual((await getJson(server, '/tiles')).body.tiles, [body.tile])
  })

  it('validates input and unknown ids', async () => {
    assert.deepEqual(await sendJson(server!, 'POST', '/tiles', { text: 'x' }), {
      status: 400, body: { ok: false, error: 'Missing text or position' },
    })
    assert.deepEqual(await sendJson(server!, 'POST', '/tiles', '{x'), { status: 400, body: { ok: false, error: 'Invalid JSON' } })
    assert.deepEqual(await sendJson(server!, 'PUT', '/tiles/nope', { text: 'x' }), {
      status: 404, body: { ok: false, error: 'Tile not found' },
    })
    assert.deepEqual(await sendJson(server!, 'DELETE', '/tiles/nope'), { status: 404, body: { ok: false, error: 'Tile not found' } })
  })
})

describe('server: static files', () => {
  let env: TestEnv
  let server: TestServer
  before(async () => { env = createTestEnv(); server = await startServer(env) })
  after(async () => { await server.stop(); env.cleanup() })

  const indexHtml = () => readFileSync(join(REPO_ROOT, 'dist/index.html'), 'utf-8')

  it('serves index.html at / and for unknown routes (SPA fallback)', async () => {
    for (const path of ['/', '/some/client/route']) {
      const res = await rawGet(server, path)
      assert.equal(res.status, 200)
      assert.equal(res.type, 'text/html')
      assert.equal(res.body, indexHtml())
    }
  })

  it('404s unknown /api paths', async () => {
    assert.equal((await rawGet(server, '/api/nothing')).status, 404)
  })

  it('blocks path traversal', async () => {
    assert.equal((await rawGet(server, '/%2e%2e/%2e%2e/package.json')).status, 403)
    assert.equal((await rawGet(server, '/..%2f..%2fpackage.json')).status, 403)
  })

  it('serves the SPA for a directory instead of crashing', async () => {
    const res = await rawGet(server, '/assets')
    assert.equal(res.status, 200)
    assert.equal(res.body, indexHtml())
    assert.equal((await getJson(server, '/health')).status, 200)
  })

  it('serves real files with their MIME type', async () => {
    const res = await rawGet(server, '/index.html')
    assert.equal(res.status, 200)
    assert.equal(res.type, 'text/html')
  })

  it('400s invalid URL encoding', async () => {
    assert.equal((await rawGet(server, '/%E0%A4%A')).status, 400)
  })
})

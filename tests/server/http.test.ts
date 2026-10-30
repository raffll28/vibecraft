/**
 * Server contract: HTTP endpoints (health, config, CORS, static files).
 *
 * Run against another implementation with VIBECRAFT_SERVER_CMD=<command>.
 */

import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
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
    assert.deepEqual(Object.keys(body).sort(), ['clients', 'events', 'ok', 'version'])
    assert.equal(body.ok, true)
    assert.equal(typeof body.version, 'string')
  })

  it('/config', async () => {
    assert.deepEqual((await getJson(server, '/config')).body, { username: 'tester', hostname: hostname() })
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
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
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

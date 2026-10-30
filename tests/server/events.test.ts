/**
 * Server contract: event ingestion (HTTP + events file), dedupe, durations,
 * WebSocket broadcast and history.
 *
 * Run against another implementation with VIBECRAFT_SERVER_CMD=<command>.
 */

import { strict as assert } from 'node:assert'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createTestEnv, type TestEnv } from '../helpers/env.ts'
import {
  connectClient, getJson, makeEvent, sendJson, sleep, startServer, waitFor, type TestServer,
} from '../helpers/server.ts'

let env: TestEnv
let server: TestServer | null = null

beforeEach(() => { env = createTestEnv() })
afterEach(async () => {
  await server?.stop()
  server = null
  env.cleanup()
})

function seedEventsFile(lines: (object | string)[]): void {
  mkdirSync(env.dataDir, { recursive: true })
  writeFileSync(env.eventsFile, lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
}

describe('server: POST /event', () => {
  it('accepts an event and counts it in /health', async () => {
    server = await startServer(env)
    assert.equal((await getJson(server, '/health')).body.events, 0)

    const res = await sendJson(server, 'POST', '/event', makeEvent())
    assert.deepEqual(res, { status: 200, body: { ok: true } })
    assert.equal((await getJson(server, '/health')).body.events, 1)
  })

  it('rejects invalid JSON with 400', async () => {
    server = await startServer(env)
    assert.deepEqual(await sendJson(server, 'POST', '/event', '{nope'), { status: 400, body: { error: 'Invalid JSON' } })
  })

  it('rejects JSON that is not an event object with 400', async () => {
    server = await startServer(env)
    for (const body of ['5', '"x"', 'null', '[1,2]']) {
      assert.deepEqual(await sendJson(server, 'POST', '/event', body), { status: 400, body: { error: 'Invalid JSON' } }, body)
    }
    assert.equal((await getJson(server, '/health')).body.events, 0)
  })

  it('rejects bodies over 1 MiB with 413', async () => {
    server = await startServer(env)
    const res = await sendJson(server, 'POST', '/event', makeEvent({ prompt: 'z'.repeat(1024 * 1024 + 10) }))
    assert.equal(res.status, 413)
  })

  it('ignores duplicate ids', async () => {
    server = await startServer(env)
    const event = makeEvent()
    await sendJson(server, 'POST', '/event', event)
    await sendJson(server, 'POST', '/event', event)
    assert.equal((await getJson(server, '/health')).body.events, 1)
  })

  it('broadcasts new events to WebSocket clients', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const event = makeEvent()
    await sendJson(server, 'POST', '/event', event)
    assert.deepEqual((await client.next('event')).payload, event)
    client.close()
  })

  it('adds duration to post_tool_use from the matching pre_tool_use', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const t0 = Date.now()
    const base = { sessionId: 's1', tool: 'Read', toolUseId: 'tu-1', toolInput: {} }
    await sendJson(server, 'POST', '/event', makeEvent({ ...base, type: 'pre_tool_use', timestamp: t0 }))
    await sendJson(server, 'POST', '/event', makeEvent({ ...base, type: 'post_tool_use', timestamp: t0 + 250, success: true }))
    await client.next('event')
    assert.equal((await client.next('event')).payload.duration, 250)
    client.close()
  })

  it('keeps at most VIBECRAFT_MAX_EVENTS in memory', async () => {
    server = await startServer(env, { VIBECRAFT_MAX_EVENTS: '5' })
    for (let i = 0; i < 8; i++) await sendJson(server, 'POST', '/event', makeEvent())
    assert.equal((await getJson(server, '/health')).body.events, 5)
  })
})

describe('server: events file', () => {
  it('loads existing events at startup, skipping blank and broken lines', async () => {
    seedEventsFile([makeEvent(), '', '{broken', makeEvent(), ''])
    server = await startServer(env)
    assert.equal((await getJson(server, '/health')).body.events, 2)
  })

  it('loads only the newest VIBECRAFT_MAX_EVENTS at startup', async () => {
    seedEventsFile(Array.from({ length: 10 }, () => makeEvent()))
    server = await startServer(env, { VIBECRAFT_MAX_EVENTS: '4' })
    assert.equal((await getJson(server, '/health')).body.events, 4)
  })

  it('picks up lines appended to the file and broadcasts them', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const event = makeEvent()
    appendFileSync(env.eventsFile, JSON.stringify(event) + '\n')
    assert.deepEqual((await client.next('event', 5000)).payload, event)
    client.close()
  })

  it('waits for a partial line to be completed', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const line = JSON.stringify(makeEvent())
    appendFileSync(env.eventsFile, line.slice(0, 20))
    await sleep(400)
    assert.equal(client.messages.filter((m) => m.type === 'event').length, 0)
    appendFileSync(env.eventsFile, line.slice(20) + '\n')
    assert.deepEqual((await client.next('event', 5000)).payload, JSON.parse(line))
    client.close()
  })

  it('keeps multibyte characters intact when a write splits them', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const event = makeEvent({ prompt: 'ação 🚀 çã' })
    const bytes = Buffer.from(JSON.stringify(event) + '\n')
    const cut = bytes.indexOf(Buffer.from('🚀')) + 2 // in the middle of the emoji
    appendFileSync(env.eventsFile, bytes.subarray(0, cut))
    await sleep(1300) // let the server read the first half on its own
    appendFileSync(env.eventsFile, bytes.subarray(cut))
    assert.deepEqual((await client.next('event', 5000)).payload, event)
    client.close()
  })

  it('ignores a POST of an event already loaded from the file at startup', async () => {
    const event = makeEvent()
    seedEventsFile([event])
    server = await startServer(env)
    await sendJson(server, 'POST', '/event', event)
    assert.equal((await getJson(server, '/health')).body.events, 1)
  })

  it('does not double count events seen via both file and HTTP', async () => {
    server = await startServer(env)
    const event = makeEvent()
    await sendJson(server, 'POST', '/event', event)
    appendFileSync(env.eventsFile, JSON.stringify(event) + '\n')
    await sleep(500)
    assert.equal((await getJson(server, '/health')).body.events, 1)
  })

  it('creates the events file if it does not exist', async () => {
    server = await startServer(env)
    await waitFor(() => {
      try { return readFileSync(env.eventsFile, 'utf-8') === '' } catch { return false }
    }, 3000, 'events file')
  })
})

describe('server: WebSocket', () => {
  it('rejects connections without an allowed Origin', async () => {
    server = await startServer(env)
    for (const origin of [null, 'http://evil.example', 'http://vibecraft.sh']) {
      const client = await connectClient(server, origin)
      const code = await new Promise<number>((r) => client.ws.once('close', (c) => r(c)))
      assert.equal(code, 1008, `origin ${origin}`)
    }
  })

  it('accepts localhost, 127.0.0.1 and https://vibecraft.sh origins', async () => {
    server = await startServer(env)
    for (const origin of ['http://localhost:1234', 'http://127.0.0.1', 'https://vibecraft.sh']) {
      const client = await connectClient(server, origin)
      await client.next('history')
      client.close()
    }
  })

  it('sends connected, then history on connect', async () => {
    seedEventsFile([makeEvent({ sessionId: 'last-session' })])
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    assert.deepEqual(client.messages.map((m) => m.type), ['connected', 'history'])
    assert.deepEqual(client.messages[0].payload, { sessionId: 'last-session' })
    client.close()
  })

  it('connected reports "unknown" when there are no events', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    assert.deepEqual((await client.next('connected')).payload, { sessionId: 'unknown' })
    client.close()
  })

  it('initial history has only recent events, at most 50', async () => {
    const old = Date.now() - 31 * 60 * 1000
    seedEventsFile([
      makeEvent({ id: 'old', timestamp: old }),
      ...Array.from({ length: 60 }, (_, i) => makeEvent({ id: `recent-${i}` })),
    ])
    server = await startServer(env)
    const client = await connectClient(server)
    const history = (await client.next('history')).payload
    assert.equal(history.length, 50)
    assert.deepEqual(history.map((e: { id: string }) => e.id), Array.from({ length: 50 }, (_, i) => `recent-${i + 10}`))
    client.close()
  })

  it('ignores whatever clients send, malformed or not', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    client.ws.send('{garbage')
    client.ws.send(JSON.stringify({ type: 'definitely_unknown' }))
    client.ws.send(JSON.stringify({ type: 'ping' }))
    await sleep(100)
    const event = makeEvent()
    await sendJson(server, 'POST', '/event', event)
    assert.deepEqual((await client.next('event')).payload, event)
    assert.equal((await getJson(server, '/health')).body.clients, 1)
    client.close()
  })

  it('/health counts connected clients', async () => {
    server = await startServer(env)
    const a = await connectClient(server)
    const b = await connectClient(server)
    await a.next('history'); await b.next('history')
    assert.equal((await getJson(server, '/health')).body.clients, 2)
    a.close()
    await waitFor(async () => (await getJson(server!, '/health')).body.clients === 1, 3000, 'client count')
    b.close()
  })
})

/**
 * Server baseline: startup, memory, event ingestion and fan-out latency.
 *
 * Usage:
 *   node bench/server.bench.ts
 *   VIBECRAFT_SERVER_CMD=path/to/binary node bench/server.bench.ts
 *
 * Throughput uses the Rust load generator (cargo build --release --examples
 * in rust/) when built: a Node fetch client saturates before either server.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv, REPO_ROOT } from '../tests/helpers/env.ts'
import { connectClient, makeEvent, SERVER_CMD, startServer, type TestClient } from '../tests/helpers/server.ts'
import { printTable, rssMiB, summarize } from './stats.ts'

const SEED_EVENTS = 1000
const POSTS = 2000
const CONCURRENCY = 16
const LOAD_SECONDS = 3
const LOAD_TOOL = join(REPO_ROOT, 'rust/target/release/examples/load')
const CLIENTS = 5
const FILE_APPENDS = 200

console.log(`Server: ${SERVER_CMD}\n`)

// --- Startup + memory with a full events file -------------------------------
const env = createTestEnv()
mkdirSync(env.dataDir, { recursive: true })
const seedLines = Array.from({ length: SEED_EVENTS }, (_, i) => JSON.stringify(makeEvent({
  type: i % 2 ? 'post_tool_use' : 'pre_tool_use',
  tool: 'Read',
  toolUseId: `seed-${i >> 1}`,
  toolInput: { file_path: '/x'.repeat(50) },
  toolResponse: { content: 'z'.repeat(2000) },
})))
writeFileSync(env.eventsFile, seedLines.join('\n') + '\n')

const startupTimes: number[] = []
for (let i = 0; i < 5; i++) {
  const t0 = performance.now()
  const s = await startServer(env)
  startupTimes.push(performance.now() - t0)
  if (i < 4) await s.stop()
  else {
    var server = s
  }
}
console.log('Startup to first healthy response (1000 events on disk):')
printTable([{ name: 'startup', ...summarize(startupTimes) }], 'ms')

const rssIdle = await rssMiB(server!.pid)

// Server capacity, with a client that isn't the bottleneck. Measured before
// WebSocket clients connect: execFileSync blocks this process, so they
// couldn't read, and ingestion is what's measured here
const loadThroughput = existsSync(LOAD_TOOL)
  ? parseInt(execFileSync(LOAD_TOOL, [String(server!.port), String(CONCURRENCY), String(LOAD_SECONDS)], { encoding: 'utf-8' }), 10)
  : null
const rssAfterLoad = await rssMiB(server!.pid)

// --- Clients that receive every broadcast ------------------------------------
const clients: TestClient[] = []
for (let i = 0; i < CLIENTS; i++) {
  const c = await connectClient(server!)
  await c.next('history')
  clients.push(c)
}

// --- POST /event latency, sequential -----------------------------------------
const seq: number[] = []
for (let i = 0; i < 500; i++) {
  const body = JSON.stringify(makeEvent())
  const t0 = performance.now()
  await fetch(`${server!.url}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  seq.push(performance.now() - t0)
}

// --- POST /event throughput, concurrent --------------------------------------
const t0 = performance.now()
let sent = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (sent < POSTS) {
    sent++
    await fetch(`${server!.url}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeEvent({ prompt: 'p'.repeat(500) })),
    })
  }
}))
const throughput = POSTS / ((performance.now() - t0) / 1000)


// --- End-to-end: line appended to events.jsonl → WebSocket client ----------
const fanout: number[] = []
const watcher = clients[0]
for (let i = 0; i < FILE_APPENDS; i++) {
  const id = `file-${i}`
  const before = watcher.messages.length
  const t1 = performance.now()
  appendFileSync(env.eventsFile, JSON.stringify(makeEvent({ id })) + '\n')
  await new Promise<void>((resolveSeen) => {
    const check = () => {
      if (watcher.messages.slice(before).some((m) => m.payload?.id === id)) resolveSeen()
      else setTimeout(check, 1)
    }
    check()
  })
  fanout.push(performance.now() - t1)
}

const rssLoaded = await rssMiB(server!.pid)

console.log(`\nPOST /event, sequential (${CLIENTS} WebSocket clients connected):`)
printTable([{ name: 'POST /event', ...summarize(seq) }], 'ms')
console.log(`\nPOST /event throughput, ${CONCURRENCY} concurrent: ${throughput.toFixed(0)} req/s (Node fetch client)`)
if (loadThroughput !== null) {
  console.log(`POST /event throughput, ${CONCURRENCY} keep-alive connections, no WebSocket clients: ${loadThroughput} req/s (Rust load client)`)
}
console.log('\nevents.jsonl append → WebSocket client receives it:')
printTable([{ name: 'file → client', ...summarize(fanout) }], 'ms')
console.log(`\nMemory (RSS): ${rssIdle.toFixed(1)} MiB after startup, ${rssAfterLoad.toFixed(1)} MiB after the load client, ${rssLoaded.toFixed(1)} MiB at the end`)

for (const c of clients) c.close()
await server!.stop()
env.cleanup()

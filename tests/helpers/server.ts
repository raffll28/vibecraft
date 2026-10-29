/**
 * Start the server as a black box on a free port, in an isolated HOME.
 *
 * Defaults to the compiled Node server; set VIBECRAFT_SERVER_CMD to run the
 * same contract tests against another implementation (e.g. a Rust binary).
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import WebSocket from 'ws'
import { REPO_ROOT, splitCommand, type TestEnv } from './env.ts'

export const SERVER_CMD = process.env.VIBECRAFT_SERVER_CMD
  ?? `node ${join(REPO_ROOT, 'dist/server/server/index.js')}`

export const ALLOWED_ORIGIN = 'http://localhost:4002'

export interface TestServer {
  pid: number
  port: number
  url: string
  /** Server stdout + stderr, for debugging failures */
  output: () => string
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        const { port } = address
        srv.close(() => resolvePort(port))
      } else {
        reject(new Error('Could not get a free port'))
      }
    })
  })
}

/**
 * Environment for anything that talks to tmux in a test: a tmux server of its
 * own (socket under the test HOME), never the user's. TMUX is dropped because
 * when set, tmux commands target that server regardless of TMUX_TMPDIR.
 */
export function tmuxEnv(env: TestEnv): NodeJS.ProcessEnv {
  const tmuxDir = join(env.home, 'tmux')
  mkdirSync(tmuxDir, { recursive: true })
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env
  return { ...rest, HOME: env.home, TMUX_TMPDIR: tmuxDir }
}

/** Run tmux against the test's own tmux server */
export function tmux(env: TestEnv, ...args: string[]): string {
  return execFileSync('tmux', args, { env: tmuxEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Stop the test's tmux server, if one was started */
export function killTmux(env: TestEnv): void {
  try { tmux(env, 'kill-server') } catch { /* no server running */ }
}

export async function startServer(env: TestEnv, extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort()
  const [cmd, args] = splitCommand(SERVER_CMD)
  const child: ChildProcess = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env: {
      ...tmuxEnv(env),
      VIBECRAFT_PORT: String(port),
      VIBECRAFT_HOST: '127.0.0.1',
      VIBECRAFT_EVENTS_FILE: env.eventsFile,
      // A tmux session that can't exist, so tmux calls fail fast and harmlessly
      VIBECRAFT_TMUX_SESSION: 'vibecraft-test-none',
      DEEPGRAM_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', (d) => { output += d })
  child.stderr?.on('data', (d) => { output += d })

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (code ${child.exitCode}):\n${output}`)
    }
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`Server did not become healthy:\n${output}`)
    }
    await sleep(5)
  }

  return {
    pid: child.pid!,
    port,
    url,
    output: () => output,
    stop: () => new Promise((resolveStop) => {
      if (child.exitCode !== null) return resolveStop()
      child.once('exit', () => resolveStop())
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Poll until check() returns a truthy value, or fail after timeoutMs */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 3000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(25)
  }
}

export async function getJson(server: TestServer, path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(server.url + path)
  return { status: res.status, body: await res.json(), headers: res.headers }
}

export async function sendJson(
  server: TestServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(server.url + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed }
}

/** A WebSocket client that records every message it receives */
export interface TestClient {
  ws: WebSocket
  messages: any[]
  /** Wait for the next message matching type (searching already-received ones first) */
  next: (type: string, timeoutMs?: number) => Promise<any>
  close: () => void
}

export async function connectClient(server: TestServer, origin: string | null = ALLOWED_ORIGIN): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, origin ? { origin } : {})
  const messages: any[] = []
  let consumed = 0
  ws.on('message', (data) => { messages.push(JSON.parse(data.toString())) })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return {
    ws,
    messages,
    next: async (type, timeoutMs = 3000) => {
      const found = await waitFor(() => {
        const index = messages.findIndex((m, i) => i >= consumed && m.type === type)
        return index >= 0 ? { index } : null
      }, timeoutMs, `WebSocket message "${type}"`)
      consumed = found.index + 1
      return messages[found.index]
    },
    close: () => ws.close(),
  }
}

/** Build a minimal valid event */
export function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sessionId = (overrides.sessionId as string) ?? 'test-session'
  return {
    id: `${sessionId}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    type: 'user_prompt_submit',
    sessionId,
    cwd: '/tmp/project',
    prompt: 'hello',
    ...overrides,
  }
}

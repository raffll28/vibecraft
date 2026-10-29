/**
 * Run the hook the way Claude Code does: spawned from Node, input on stdin.
 *
 * Node gives the child a socket for stdin on Linux, so this also guards the
 * /dev/stdin regression. VIBECRAFT_HOOK_CMD overrides the hook binary.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, splitCommand, type TestEnv } from './env.ts'

export const HOOK_CMD = process.env.VIBECRAFT_HOOK_CMD ?? join(REPO_ROOT, 'rust/target/release/vibecraft-hook')

export interface HookResult {
  code: number | null
  stdout: string
  stderr: string
  /** Events appended to the events file during this run */
  events: Record<string, unknown>[]
  /** Raw lines of the events file */
  lines: string[]
}

export async function runHook(
  env: TestEnv,
  input: string | object,
  extraEnv: Record<string, string> = {},
): Promise<HookResult> {
  const [cmd, args] = splitCommand(HOOK_CMD)
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      HOME: env.home,
      VIBECRAFT_EVENTS_FILE: env.eventsFile,
      VIBECRAFT_ENABLE_WS_NOTIFY: 'false',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))

  const code = await new Promise<number | null>((resolveExit) => child.on('close', resolveExit))

  const content = existsSync(env.eventsFile) ? readFileSync(env.eventsFile, 'utf-8') : ''
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')
  return {
    code,
    stdout,
    stderr,
    lines,
    events: lines.filter(Boolean).map((l) => JSON.parse(l)),
  }
}

/** Drop the fields that vary between runs (id, timestamp) after checking their shape */
export function stripVolatile(event: Record<string, unknown>): Record<string, unknown> {
  const { id, timestamp, ...rest } = event
  if (typeof id !== 'string' || !id.startsWith(`${String(event.sessionId)}-`)) {
    throw new Error(`Unexpected event id: ${String(id)}`)
  }
  if (typeof timestamp !== 'number' || Math.abs(Date.now() - timestamp) > 60_000) {
    throw new Error(`Unexpected event timestamp: ${String(timestamp)}`)
  }
  return rest
}

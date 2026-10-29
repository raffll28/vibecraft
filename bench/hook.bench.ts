/**
 * Hook latency: how long each Claude Code tool call waits on the hook.
 *
 * Spawns the hook from Node (like Claude Code) with realistic inputs and
 * reports wall time per call. Usage:
 *   node bench/hook.bench.ts [runs]
 *   VIBECRAFT_HOOK_CMD=path/to/binary node bench/hook.bench.ts
 *   BENCH_NOTIFY_URL=http://127.0.0.1:4003/event node bench/hook.bench.ts
 *     (also POST each event to a running server, as in real use)
 */

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv } from '../tests/helpers/env.ts'
import { HOOK_CMD, runHook } from '../tests/helpers/hook.ts'
import { summarize, printTable } from './stats.ts'

const RUNS = parseInt(process.argv[2] ?? '200', 10)
const NOTIFY_URL = process.env.BENCH_NOTIFY_URL
const hookEnv: Record<string, string> = NOTIFY_URL
  ? { VIBECRAFT_ENABLE_WS_NOTIFY: 'true', VIBECRAFT_WS_NOTIFY: NOTIFY_URL }
  : {}
const env = createTestEnv()

// A transcript like a real session's: alternating prompts, replies and tool calls
const transcript = join(env.home, 'transcript.jsonl')
const lines: string[] = []
for (let i = 0; i < 400; i++) {
  lines.push(JSON.stringify(i % 4 === 0
    ? { type: 'user', message: { content: [{ type: 'text', text: `prompt ${i} `.repeat(20) }] } }
    : { type: 'assistant', message: { content: [{ type: 'text', text: `reply ${i} `.repeat(60) }, { type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } }))
}
writeFileSync(transcript, lines.join('\n') + '\n')

const base = { session_id: 'bench-session', cwd: '/home/user/project', transcript_path: transcript }
const cases: Record<string, object> = {
  PreToolUse: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 'tu' },
  PostToolUse: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: { content: 'line\n'.repeat(4000) }, tool_use_id: 'tu' },
  Stop: { ...base, hook_event_name: 'Stop' },
  UserPromptSubmit: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
}

console.log(`Hook: ${HOOK_CMD}`)
console.log(`${RUNS} runs per event type (server notify: ${NOTIFY_URL ?? 'disabled'})\n`)

const rows = []
for (const [name, input] of Object.entries(cases)) {
  for (let i = 0; i < 5; i++) await runHook(env, input, hookEnv) // warm up caches
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    // runHook re-reads the whole events file, so keep it at one event:
    // otherwise later cases would time that parsing, not the hook
    rmSync(env.eventsFile, { force: true })
    const start = performance.now()
    const result = await runHook(env, input, hookEnv)
    times.push(performance.now() - start)
    if (result.code !== 0) throw new Error(`hook failed: ${result.stderr}`)
  }
  rows.push({ name, ...summarize(times) })
}
printTable(rows, 'ms')
env.cleanup()

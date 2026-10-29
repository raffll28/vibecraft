/**
 * Per-call cost of the tmux pane parsers: TypeScript vs vibecraft-core (Rust).
 *
 * Panes are ~100-line captures like the server polls every 1-5 s, half of them
 * showing a permission prompt. Usage: node bench/core.bench.ts [iterations]
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv, REPO_ROOT } from '../tests/helpers/env.ts'
import { detectPermissionPrompt, parseTokensFromOutput } from '../server/tmuxParsing.ts'

const ITERATIONS = parseInt(process.argv[2] ?? '2000', 10)

function pane(withPrompt: boolean, n: number): string {
  const lines = Array.from({ length: 90 }, (_, i) => `  ${i} │ const value${i} = compute(${i}) // output line ${n}`)
  lines.push(`✻ Working… (${n}s · ↓ ${(n * 137).toLocaleString('en-US')} tokens · esc to interrupt)`)
  if (withPrompt) {
    lines.push('● Bash(rm -rf /tmp/build)', ' Bash command', '   rm -rf /tmp/build', '', ' Do you want to proceed?',
      ' ❯ 1. Yes', "   2. Yes, and don't ask again", '   3. No, and tell Claude what to do differently (esc)', '',
      ' Esc to cancel · Tab to add additional instructions')
  }
  return lines.join('\n')
}
const corpus = Array.from({ length: 20 }, (_, i) => pane(i % 2 === 0, i))

function timeTs(f: (s: string) => unknown): number {
  for (let i = 0; i < 200; i++) for (const p of corpus) f(p) // JIT warm-up
  const start = process.hrtime.bigint()
  for (let i = 0; i < ITERATIONS; i++) for (const p of corpus) f(p)
  return Number(process.hrtime.bigint() - start) / (ITERATIONS * corpus.length)
}

const env = createTestEnv()
const corpusFile = join(env.home, 'corpus.json')
writeFileSync(corpusFile, JSON.stringify(corpus))
const rust = JSON.parse(execFileSync(join(REPO_ROOT, 'rust/target/release/examples/core_bench'), [corpusFile, String(ITERATIONS)], { encoding: 'utf-8' }))
env.cleanup()

const ts = { parseTokensFromOutput: timeTs(parseTokensFromOutput), detectPermissionPrompt: timeTs(detectPermissionPrompt) }

console.log(`${corpus.length} panes x ${ITERATIONS} iterations (~100 lines each, half with a prompt)\n`)
console.log(`${'function'.padEnd(26)}${'TypeScript'.padStart(14)}${'Rust'.padStart(12)}${'speedup'.padStart(10)}`)
for (const fn of Object.keys(ts) as (keyof typeof ts)[]) {
  console.log(`${fn.padEnd(26)}${`${(ts[fn] / 1000).toFixed(2)} µs`.padStart(14)}${`${(rust[fn] / 1000).toFixed(2)} µs`.padStart(12)}${`${(ts[fn] / rust[fn]).toFixed(1)}x`.padStart(10)}`)
}

/**
 * Differential fuzzing: the TypeScript server functions vs the Rust
 * vibecraft-core crate, on random inputs biased toward the characters each
 * parser cares about (arrows, digits, JS-only whitespace, \r, selectors...).
 *
 * Usage: node tests/differential/core.diff.ts [cases-per-function] [seed]
 * (npm run test:diff builds the Rust oracle first)
 *
 * isOriginAllowed is allowed to differ in one direction only: the Rust port
 * may reject odd origins TypeScript accepts (stricter), never the reverse.
 */

import { spawn } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { REPO_ROOT } from '../helpers/env.ts'
import { detectBypassWarning, detectPermissionPrompt, parseTokensFromOutput } from '../../server/tmuxParsing.ts'
import { expandHome, isOriginAllowed, validateTmuxSession } from '../../server/validation.ts'

const CASES = parseInt(process.argv[2] ?? '20000', 10)
let seed = parseInt(process.argv[3] ?? String(Date.now() % 1e9), 10)
const initialSeed = seed

// mulberry32: small seeded PRNG, so failures can be replayed
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
const repeat = (n: number, f: () => string) => Array.from({ length: n }, f).join('')

const SPACES = [' ', ' ', ' ', '\t', ' ', ' ', '﻿', '\u0085', '᠎', '　', '\r', ' ', '\v']
const space = () => (rand() < 0.7 ? '' : repeat(1 + Math.floor(rand() * 3), () => pick(SPACES)))

/** "↓ <n> tokens" in Claude Code's status line, with a mutation half the time */
function structuredTokens(): string {
  const num = pick([
    () => String(Math.floor(rand() * 100000)),
    () => Math.floor(rand() * 100000).toLocaleString('en-US'),
    () => `${(rand() * 200).toFixed(pick([0, 1, 2, 4]))}k`,
    () => pick(['0', '0k', '.5k', '5.k', '1.2.3k', ',', '1,,2']),
  ])()
  let text = `✻ Working… (${Math.floor(rand() * 90)}s · ${pick(['↓', '↓', '↑'])}${pick([' ', '', '  ', '\u00a0'])}${num}${pick([' ', '', '\t'])}${pick(['tokens', 'token', 'Tokens'])} · esc to interrupt)`
  if (rand() < 0.5) text = text.replace(/./g, (c) => (rand() < 0.05 ? pick(SPACES) : c))
  return rand() < 0.3 ? `${text}\n${structuredTokens()}` : text
}

function tokenText(): string {
  if (rand() < 0.6) return structuredTokens()
  const parts = [
    () => '↓', () => '↑', () => space(),
    () => repeat(1 + Math.floor(rand() * 4), () => pick(['0', '1', '5', '9', ',', '.'])),
    () => pick(['k', 'K', 'K']), // the last one is the Kelvin sign
    () => pick(['token', 'tokens', 'TOKENS', 'Token', 'tokenz', 'tok', 'ſ']),
    () => pick(['(', ')', '·', 'x', '\n', '✻ Working… ']),
  ]
  return repeat(1 + Math.floor(rand() * 12), () => pick(parts)())
}

function promptLine(): string {
  const lines = [
    () => `${space()}${pick(['●', '◐', '·', '•', ''])}${space()}${pick(['Bash', 'Read', 'Edit', 'my_tool', 'Ünï', ''])}${space()}${pick(['(', '', ' ('])}${pick(['ls -la)', 'x', ''])}`,
    () => `${space()}${pick(['Bash', 'bash', 'READ', 'WebFetch', 'WebSearch', 'Glob', 'Bashful', 'Task'])}${space()}${pick(['command', 'file', '', 'x'])}`,
    () => `${space()}${pick(['Do you want', 'do YOU want', 'Would you like', 'Would you'])} to proceed${pick(['?', '', '?!'])}`,
    () => `${space()}${pick(['❯', '>', '❯❯', ''])}${space()}${pick(['1', '2', '3', '12', 'x'])}${pick(['.', '', '. '])}${space()}${pick(['Yes', 'No, and tell Claude', '', '  ', 'Yes\r', 'a b'])}`,
    () => `${space()}${pick(['Esc to cancel', 'esc TO cancel', 'ctrl-g to edit in Vim', 'Esc to', 'Tab to add'])}`,
    () => pick(['', 'some output', '  ⎿  Running…', 'WARNING', 'Bypass Permissions mode']),
  ]
  return pick(lines)()
}

const randomPrompt = () => Array.from({ length: Math.floor(rand() * 40) }, promptLine).join(pick(['\n', '\n', '\n', '\r\n']))

/** A well-formed prompt, then a few random mutations, so most cases sit near the edge */
function structuredPrompt(): string {
  const lines: string[] = []
  for (let i = Math.floor(rand() * 25); i > 0; i--) lines.push(pick(['output', '', '  ⎿  Running…', 'x'.repeat(5)]))
  lines.push(`${pick(['●', '◐', '·'])} ${pick(['Bash', 'Edit', 'Read', 'Write'])}(${pick(['rm /tmp/x', 'src/a.ts', 'prompt: build'])})`)
  if (rand() < 0.5) lines.push(` ${pick(['Bash', 'Read', 'Edit'])} ${pick(['command', 'file'])}`, '   detail line')
  lines.push(` ${pick(['Do you want to proceed?', 'Would you like to proceed?'])}`)
  const n = 1 + Math.floor(rand() * 4)
  const selected = Math.floor(rand() * n)
  for (let i = 1; i <= n; i++) lines.push(`${i - 1 === selected ? ' ❯' : '  '} ${i}. ${pick(['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)', 'Type here'])}`)
  lines.push('', pick([' Esc to cancel · Tab to add additional instructions', ' ctrl-g to edit in Vim · ~/.claude/plans/x.md', '']))
  for (let i = Math.floor(rand() * 12); i > 0; i--) lines.push(pick(['', 'after']))

  for (let m = Math.floor(rand() * 4); m > 0; m--) {
    const i = Math.floor(rand() * lines.length)
    switch (Math.floor(rand() * 6)) {
      case 0: lines.splice(i, 1); break
      case 1: lines.splice(i, 0, lines[i] ?? ''); break
      case 2: lines.splice(i, 0, promptLine()); break
      case 3: lines[i] = (lines[i] ?? '').replace(/ /g, () => pick(SPACES)); break
      case 4: lines[i] = (lines[i] ?? '') + pick(['\r', ' ', '\u2028x', '']); break
      case 5: { const j = Math.floor(rand() * lines.length); [lines[i], lines[j]] = [lines[j], lines[i]] }
    }
  }
  return lines.join('\n')
}

const promptText = () => (rand() < 0.6 ? structuredPrompt() : randomPrompt())

function origin(): string {
  return `${pick(['http', 'https', 'HTTP', 'ws', 'file', 'ftp', ''])}${pick(['://', ':/', ''])}` +
    `${pick(['', 'user@', 'a:b@'])}${pick(['localhost', 'LOCALHOST', '127.0.0.1', 'vibecraft.sh', 'VibeCraft.SH', 'evil.com', 'localhost.', '127.0.0.2', 'localhost.evil.com', ''])}` +
    `${pick(['', ':', ':4002', ':0', ':65535', ':65536', ':x'])}${pick(['', '/', '/path?q#f', '?x', '#y'])}`
}

const tmuxName = () => repeat(Math.floor(rand() * 6), () => pick(['a', 'Z', '9', '_', '-', '.', ' ', ';', 'ç', '$']))
const homePath = () => `${pick(['~', '~/', '~user', '/', '', './'])}${pick(['', 'a', 'a/b', '~'])}`

const functions: Record<string, { gen: () => string; ts: (input: string) => unknown }> = {
  parseTokensFromOutput: { gen: tokenText, ts: parseTokensFromOutput },
  detectBypassWarning: { gen: promptText, ts: detectBypassWarning },
  detectPermissionPrompt: { gen: promptText, ts: detectPermissionPrompt },
  isOriginAllowed: { gen: origin, ts: isOriginAllowed },
  validateTmuxSession: {
    gen: tmuxName,
    ts: (s) => { try { validateTmuxSession(s); return true } catch { return false } },
  },
  expandHome: { gen: homePath, ts: expandHome },
}

const oracle = spawn(join(REPO_ROOT, 'rust/target/release/examples/oracle'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending: ((line: string) => void)[] = []
// Split on \n only: readline would also break lines on U+2028, which
// serde_json leaves unescaped
let buffered = ''
oracle.stdout.setEncoding('utf-8')
oracle.stdout.on('data', (chunk: string) => {
  buffered += chunk
  let nl: number
  while ((nl = buffered.indexOf('\n')) !== -1) {
    pending.shift()!(buffered.slice(0, nl))
    buffered = buffered.slice(nl + 1)
  }
})
const ask = (fn: string, input: string) => new Promise<unknown>((resolveAnswer) => {
  pending.push((line) => resolveAnswer(JSON.parse(line)))
  oracle.stdin.write(JSON.stringify({ fn, input }) + '\n')
})

let failures = 0
for (const [fn, { gen, ts }] of Object.entries(functions)) {
  let stricter = 0
  let nonTrivial = 0
  const stricterSamples = new Set<string>()
  const batch: Promise<void>[] = []
  for (let i = 0; i < CASES; i++) {
    const input = gen()
    const expected = ts(input) ?? null
    if (expected !== null && expected !== false && expected !== input) nonTrivial++
    batch.push(ask(fn, input).then((got) => {
      if (isDeepStrictEqual(got, expected)) return
      if (fn === 'isOriginAllowed' && expected === true && got === false) {
        stricter++
        if (stricterSamples.size < 12) stricterSamples.add(input)
        return
      }
      failures++
      if (failures <= 10) {
        console.log(`MISMATCH ${fn} input=${JSON.stringify(input)}\n  ts:   ${JSON.stringify(expected)}\n  rust: ${JSON.stringify(got)}`)
      }
    }))
  }
  await Promise.all(batch)
  console.log(`${fn}: ${CASES} cases, ${nonTrivial} with a non-empty result${stricter ? `, ${stricter} origins rejected only by Rust (stricter, allowed)` : ''}`)
  if (stricterSamples.size) console.log(`  e.g. ${[...stricterSamples].map((s) => JSON.stringify(s)).join(' ')}`)
}
oracle.stdin.end()

console.log(failures ? `\n${failures} mismatches (seed ${initialSeed})` : `\nNo mismatches (seed ${initialSeed})`)
process.exit(failures ? 1 : 0)

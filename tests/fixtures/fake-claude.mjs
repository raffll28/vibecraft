#!/usr/bin/env node
/**
 * Stand-in for the Claude Code CLI in session tests, installed as
 * $HOME/.local/bin/claude (first on the PATH the server gives tmux).
 *
 * Logs to $HOME/fake-claude.log: its args and cwd, every typed line, Ctrl+C,
 * and keys pressed while a prompt is on screen. Typed commands:
 *   show-prompt    a Bash permission prompt ("Do you want to proceed?")
 *   show-warning   the --dangerously-skip-permissions warning
 *   tokens <n>     a status line with "↓ <n> tokens"
 *   clear          scroll everything out of the detection window
 */

import { appendFileSync } from 'node:fs'

const log = (line) => appendFileSync(`${process.env.HOME}/fake-claude.log`, `${line}\n`)
const print = (text) => process.stdout.write(text.replace(/\n/g, '\r\n') + '\r\n')
const clear = () => print('\n'.repeat(60))

log(`args: ${process.argv.slice(2).join(' ')}`)
log(`cwd: ${process.cwd()}`)
print('fake claude ready')

let waitingFor = null // 'prompt' | 'warning': the next digit answers it
let line = ''

function command(text) {
  log(`input: ${text}`)
  if (text === 'show-prompt') {
    waitingFor = 'prompt'
    print([
      '● Bash(rm -rf /tmp/fake)',
      '',
      ' Bash command',
      '   rm -rf /tmp/fake',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again",
      '   3. No, and tell Claude what to do differently (esc)',
      '',
      ' Esc to cancel · Tab to add additional instructions',
    ].join('\n'))
  } else if (text === 'show-warning') {
    waitingFor = 'warning'
    print([
      '│ WARNING │',
      '│ You are entering Bypass Permissions mode. In this mode: │',
      '│   1. No, exit Claude Code │',
      '│ ❯ 2. Yes, I understand and accept the risks │',
    ].join('\n'))
  } else if (text.startsWith('tokens ')) {
    print(`✻ Working… (3s · ↓ ${text.slice(7)} tokens · esc to interrupt)`)
  } else if (text === 'clear') {
    clear()
  }
}

process.stdin.setRawMode(true)
process.stdin.on('data', (data) => {
  for (const ch of data.toString()) {
    if (ch === '\x03') {
      log('ctrl-c')
    } else if (waitingFor && /\d/.test(ch)) {
      log(`answer ${waitingFor}: ${ch}`)
      waitingFor = null
      clear()
    } else if (ch === '\r' || ch === '\n') {
      if (line) command(line)
      line = ''
    } else {
      line += ch
    }
  }
})

/**
 * Unit tests for the server's pure functions, driven by shared JSON fixtures
 * (tests/fixtures/*.json) so a Rust port can be checked against the same cases.
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { detectBypassWarning, detectPermissionPrompt, parseTokensFromOutput } from '../../server/tmuxParsing.ts'
import { expandHome, isOriginAllowed, validateDirectoryPath, validateTmuxSession } from '../../server/validation.ts'

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf-8'))
const tmux = fixture('tmux-parsing.json')
const validation = fixture('validation.json')

describe('parseTokensFromOutput', () => {
  for (const c of tmux.parseTokensFromOutput) {
    it(c.name, () => assert.equal(parseTokensFromOutput(c.input), c.expected))
  }
})

describe('detectBypassWarning', () => {
  for (const c of tmux.detectBypassWarning) {
    it(c.name, () => assert.equal(detectBypassWarning(c.input), c.expected))
  }
})

describe('detectPermissionPrompt', () => {
  for (const c of tmux.detectPermissionPrompt) {
    it(c.name, () => assert.deepEqual(detectPermissionPrompt(c.input), c.expected))
  }
})

describe('isOriginAllowed', () => {
  for (const c of validation.isOriginAllowed) {
    it(String(c.input), () => assert.equal(isOriginAllowed(c.input ?? undefined), c.expected))
  }
})

describe('validateTmuxSession', () => {
  for (const c of validation.validateTmuxSession) {
    it(JSON.stringify(c.input), () => {
      if (c.valid) assert.equal(validateTmuxSession(c.input), c.input)
      else assert.throws(() => validateTmuxSession(c.input), /Invalid tmux session name/)
    })
  }
})

describe('expandHome', () => {
  for (const c of validation.expandHome) {
    it(c.input, () => assert.equal(expandHome(c.input), c.expected.replace('$HOME', process.env.HOME ?? '')))
  }
})

describe('validateDirectoryPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibecraft-unit-'))
  const ok = join(root, 'project-ok')
  const bad = join(root, 'bad;name')
  mkdirSync(ok)
  mkdirSync(bad)
  writeFileSync(join(root, 'file.txt'), '')

  it('resolves a valid directory', () => {
    assert.equal(validateDirectoryPath(ok), ok)
    assert.equal(validateDirectoryPath(join(ok, '..', 'project-ok')), ok)
  })
  it('rejects missing paths', () => {
    assert.throws(() => validateDirectoryPath(join(root, 'missing')), /does not exist/)
  })
  it('rejects files', () => {
    assert.throws(() => validateDirectoryPath(join(root, 'file.txt')), /not a directory/)
  })
  it('rejects shell metacharacters', () => {
    assert.throws(() => validateDirectoryPath(bad), /invalid characters/)
  })
  it('cleanup', () => rmSync(root, { recursive: true, force: true }))
})

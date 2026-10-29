/**
 * Isolated environments for black-box tests.
 *
 * Every test gets its own temp HOME, so nothing touches the real
 * ~/.vibecraft/ (the server and ProjectsManager resolve paths from HOME).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '../..')

export interface TestEnv {
  home: string
  dataDir: string
  eventsFile: string
  cleanup: () => void
}

export function createTestEnv(): TestEnv {
  const home = mkdtempSync(join(tmpdir(), 'vibecraft-test-'))
  const dataDir = join(home, '.vibecraft', 'data')
  return {
    home,
    dataDir,
    eventsFile: join(dataDir, 'events.jsonl'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/** Split a command string like "node dist/x.js" into [cmd, ...args] */
export function splitCommand(command: string): [string, string[]] {
  const [cmd, ...args] = command.trim().split(/\s+/)
  return [cmd, args]
}

/**
 * GitStatusManager - Track git status for managed sessions
 *
 * Polls git status independently of Claude activity so we always
 * know the state of each session's working directory.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitStatus } from '../shared/types.js'

const execFileAsync = promisify(execFile)

// Re-export GitStatus for convenience
export type { GitStatus }

export interface GitStatusUpdate {
  sessionId: string
  status: GitStatus
}

// ============================================================================
// GitStatusManager
// ============================================================================

export class GitStatusManager {
  private statusCache = new Map<string, GitStatus>()
  private directories = new Map<string, string>() // sessionId -> directory
  private dirty = new Set<string>() // sessionIds that may have changed since last poll
  private pollCount = 0
  private pollInterval: NodeJS.Timeout | null = null
  private onUpdate: ((update: GitStatusUpdate) => void) | null = null

  // Configuration
  private readonly POLL_INTERVAL_MS = 5000 // Poll dirty sessions every 5 seconds
  private readonly FULL_POLL_EVERY = 12     // Poll everything every 12 polls (~1 min)
  private readonly EXEC_TIMEOUT_MS = 5000  // Timeout for git commands

  constructor() {}

  /**
   * Set callback for status updates
   */
  setUpdateHandler(handler: (update: GitStatusUpdate) => void): void {
    this.onUpdate = handler
  }

  /**
   * Register a session's working directory to track
   */
  track(sessionId: string, directory: string): void {
    this.directories.set(sessionId, directory)
    // Immediately fetch status for new session
    this.fetchStatus(sessionId, directory)
  }

  /**
   * Stop tracking a session
   */
  untrack(sessionId: string): void {
    this.directories.delete(sessionId)
    this.statusCache.delete(sessionId)
    this.dirty.delete(sessionId)
  }

  /**
   * Flag a session for the next poll (e.g. after a tool that may touch files).
   * Each poll runs ~6 git commands, so clean sessions are only re-checked on
   * the slow full poll, which catches changes made outside Claude.
   */
  markDirty(sessionId: string): void {
    if (this.directories.has(sessionId)) this.dirty.add(sessionId)
  }

  /**
   * Get cached status for a session
   */
  getStatus(sessionId: string): GitStatus | null {
    return this.statusCache.get(sessionId) ?? null
  }

  /**
   * Get all cached statuses
   */
  getAllStatuses(): Map<string, GitStatus> {
    return new Map(this.statusCache)
  }

  /**
   * Start polling for git status
   */
  start(): void {
    if (this.pollInterval) return

    this.pollInterval = setInterval(() => {
      this.pollAll()
    }, this.POLL_INTERVAL_MS)

    // Initial poll
    this.pollAll()
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  /**
   * Force refresh status for a session
   */
  async refresh(sessionId: string): Promise<GitStatus | null> {
    const directory = this.directories.get(sessionId)
    if (!directory) return null
    return this.fetchStatus(sessionId, directory)
  }

  /**
   * Poll dirty directories, or all of them on every FULL_POLL_EVERY-th poll
   */
  private async pollAll(): Promise<void> {
    const full = this.pollCount++ % this.FULL_POLL_EVERY === 0
    const entries = Array.from(this.directories.entries())
      .filter(([sessionId]) => full || this.dirty.has(sessionId))
    this.dirty.clear()

    const promises = entries.map(
      ([sessionId, directory]) => this.fetchStatus(sessionId, directory)
    )
    await Promise.all(promises)
  }

  /**
   * Fetch git status for a directory
   */
  private async fetchStatus(sessionId: string, directory: string): Promise<GitStatus> {
    const status = await this.getGitStatus(directory)

    // Check if status changed
    const oldStatus = this.statusCache.get(sessionId)
    const changed = !oldStatus || this.hasStatusChanged(oldStatus, status)

    this.statusCache.set(sessionId, status)

    // Notify if changed
    if (changed && this.onUpdate) {
      this.onUpdate({ sessionId, status })
    }

    return status
  }

  /**
   * Check if status has meaningfully changed
   */
  private hasStatusChanged(old: GitStatus, current: GitStatus): boolean {
    return (
      old.branch !== current.branch ||
      old.ahead !== current.ahead ||
      old.behind !== current.behind ||
      old.totalFiles !== current.totalFiles ||
      old.linesAdded !== current.linesAdded ||
      old.linesRemoved !== current.linesRemoved ||
      old.lastCommitTime !== current.lastCommitTime
    )
  }

  /**
   * Get git status for a directory
   */
  private async getGitStatus(directory: string): Promise<GitStatus> {
    const emptyStatus: GitStatus = {
      branch: '',
      ahead: 0,
      behind: 0,
      staged: { added: 0, modified: 0, deleted: 0 },
      unstaged: { added: 0, modified: 0, deleted: 0 },
      untracked: 0,
      totalFiles: 0,
      linesAdded: 0,
      linesRemoved: 0,
      lastCommitTime: null,
      lastCommitMessage: null,
      isRepo: false,
      lastChecked: Date.now(),
    }

    try {
      // Check if it's a git repo
      await this.execGit(['rev-parse', '--git-dir'], directory)
    } catch {
      // Not a git repo
      return emptyStatus
    }

    const status: GitStatus = {
      ...emptyStatus,
      isRepo: true,
    }

    // Run all git commands in parallel
    const [
      branchResult,
      statusResult,
      diffStagedResult,
      diffUnstagedResult,
      logResult,
    ] = await Promise.all([
      this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory).catch(() => ''),
      this.execGit(['status', '--porcelain'], directory).catch(() => ''),
      this.execGit(['diff', '--cached', '--shortstat'], directory).catch(() => ''),
      this.execGit(['diff', '--shortstat'], directory).catch(() => ''),
      this.execGit(['log', '-1', '--format=%ct|||%s'], directory).catch(() => ''),
    ])

    // Parse branch
    status.branch = branchResult.trim()

    // Parse ahead/behind
    try {
      const abResult = await this.execGit(
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        directory
      )
      const [behind, ahead] = abResult.trim().split(/\s+/).map(Number)
      status.ahead = ahead || 0
      status.behind = behind || 0
    } catch {
      // No upstream configured
    }

    // Parse status --porcelain
    // trimEnd, not trim: the leading space of " M file" is the staged column
    const statusLines = statusResult.trimEnd().split('\n').filter(Boolean)
    for (const line of statusLines) {
      const staged = line[0]
      const unstaged = line[1]

      // Staged changes
      if (staged === 'A') status.staged.added++
      else if (staged === 'M') status.staged.modified++
      else if (staged === 'D') status.staged.deleted++

      // Unstaged changes
      if (unstaged === 'M') status.unstaged.modified++
      else if (unstaged === 'D') status.unstaged.deleted++

      // Untracked
      if (staged === '?' && unstaged === '?') status.untracked++
    }

    // Parse diff stats
    const parseDiffStat = (output: string): { added: number; removed: number } => {
      const match = output.match(/(\d+) insertion.*?(\d+) deletion/i)
      if (match) {
        return { added: parseInt(match[1], 10), removed: parseInt(match[2], 10) }
      }
      const addMatch = output.match(/(\d+) insertion/i)
      const delMatch = output.match(/(\d+) deletion/i)
      return {
        added: addMatch ? parseInt(addMatch[1], 10) : 0,
        removed: delMatch ? parseInt(delMatch[1], 10) : 0,
      }
    }

    const stagedDiff = parseDiffStat(diffStagedResult)
    const unstagedDiff = parseDiffStat(diffUnstagedResult)
    status.linesAdded = stagedDiff.added + unstagedDiff.added
    status.linesRemoved = stagedDiff.removed + unstagedDiff.removed

    // Total files
    status.totalFiles =
      status.staged.added + status.staged.modified + status.staged.deleted +
      status.unstaged.modified + status.unstaged.deleted +
      status.untracked

    // Parse last commit
    if (logResult) {
      const [timestamp, message] = logResult.trim().split('|||')
      status.lastCommitTime = parseInt(timestamp, 10) || null
      status.lastCommitMessage = message || null
    }

    return status
  }

  /**
   * Execute a git command in a directory using execFile (no shell).
   * Args should be passed as an array, not a string, to prevent command injection.
   */
  private async execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: this.EXEC_TIMEOUT_MS,
    })
    return stdout
  }
}

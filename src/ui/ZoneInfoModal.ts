/**
 * Zone Info Modal - Displays detailed information about a session/zone
 *
 * Shows session stats, git status, token usage, files touched, etc.
 */

import type { ManagedSession, GitStatus } from '../../shared/types'
import { formatTimeAgo } from './FeedManager'

// ============================================================================
// Types
// ============================================================================

export interface ZoneInfoData {
  /** The managed session data */
  managedSession: ManagedSession
  /** Session-specific stats from main.ts state */
  stats?: {
    toolsUsed: number
    filesTouched: Set<string>
    activeSubagents: number
  }
}

// ============================================================================
// State
// ============================================================================

let modal: HTMLElement | null = null

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the zone info modal
 */
export function setupZoneInfoModal(): void {
  modal = document.getElementById('zone-info-modal')

  const closeBtn = document.getElementById('zone-info-close')
  closeBtn?.addEventListener('click', hideZoneInfoModal)

  // Close on backdrop click
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideZoneInfoModal()
    }
  })

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal?.classList.contains('visible')) {
      hideZoneInfoModal()
    }
  })
}

/**
 * Show the zone info modal with session data
 */
export function showZoneInfoModal(data: ZoneInfoData): void {
  if (!modal) return


  renderContent(data)
  modal.classList.add('visible')
}

/**
 * Hide the zone info modal
 */
export function hideZoneInfoModal(): void {
  if (!modal) return


  modal.classList.remove('visible')
}

// ============================================================================
// Rendering
// ============================================================================

function renderContent(data: ZoneInfoData): void {
  const content = document.getElementById('zone-info-content')
  if (!content) return

  const { managedSession: s, stats } = data
  const filesTouched = stats?.filesTouched ? Array.from(stats.filesTouched) : []

  content.innerHTML = `
    <!-- Header -->
    <div class="zone-info-header">
      <div class="zone-info-name">${escapeHtml(s.name)}</div>
      <div class="zone-info-status zone-info-status--${s.status}">${s.status}</div>
    </div>

    <!-- Basic Info -->
    <div class="zone-info-section">
      <div class="zone-info-row">
        <span class="zone-info-label">Directory</span>
        <span class="zone-info-value zone-info-mono">${escapeHtml(s.cwd || '~')}</span>
      </div>
      <div class="zone-info-row">
        <span class="zone-info-label">tmux Session</span>
        <span class="zone-info-value zone-info-mono">${escapeHtml(s.tmuxSession)}</span>
      </div>
      <div class="zone-info-row">
        <span class="zone-info-label">Created</span>
        <span class="zone-info-value">${formatTimeAgo(s.createdAt)}</span>
      </div>
      <div class="zone-info-row">
        <span class="zone-info-label">Last Activity</span>
        <span class="zone-info-value">${formatTimeAgo(s.lastActivity)}</span>
      </div>
      ${s.currentTool ? `
      <div class="zone-info-row">
        <span class="zone-info-label">Current Tool</span>
        <span class="zone-info-value zone-info-highlight">${escapeHtml(s.currentTool)}</span>
      </div>
      ` : ''}
    </div>

    <!-- Stats -->
    <div class="zone-info-section">
      <div class="zone-info-section-title">Statistics</div>
      <div class="zone-info-stats-grid">
        <div class="zone-info-stat">
          <div class="zone-info-stat-value">${stats?.toolsUsed ?? 0}</div>
          <div class="zone-info-stat-label">Tools Used</div>
        </div>
        <div class="zone-info-stat">
          <div class="zone-info-stat-value">${filesTouched.length}</div>
          <div class="zone-info-stat-label">Files Touched</div>
        </div>
        <div class="zone-info-stat">
          <div class="zone-info-stat-value">${stats?.activeSubagents ?? 0}</div>
          <div class="zone-info-stat-label">Subagents</div>
        </div>
      </div>
    </div>

    <!-- Tokens -->
    ${s.tokens ? `
    <div class="zone-info-section">
      <div class="zone-info-section-title">Token Usage</div>
      <div class="zone-info-tokens">
        <div class="zone-info-token-row">
          <span>Current Conversation</span>
          <span class="zone-info-token-value">${formatNumber(s.tokens.current)}</span>
        </div>
        <div class="zone-info-token-row">
          <span>Cumulative (Session)</span>
          <span class="zone-info-token-value">${formatNumber(s.tokens.cumulative)}</span>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- Git Status -->
    ${s.gitStatus?.isRepo ? renderGitStatus(s.gitStatus) : `
    <div class="zone-info-section">
      <div class="zone-info-section-title">Git Status</div>
      <div class="zone-info-muted">Not a git repository</div>
    </div>
    `}

    <!-- Files Touched -->
    ${filesTouched.length > 0 ? `
    <div class="zone-info-section">
      <div class="zone-info-section-title">Files Touched (${filesTouched.length})</div>
      <div class="zone-info-files">
        ${filesTouched.slice(0, 10).map(f => `
          <div class="zone-info-file">${escapeHtml(shortenPath(f))}</div>
        `).join('')}
        ${filesTouched.length > 10 ? `
          <div class="zone-info-file zone-info-muted">... and ${filesTouched.length - 10} more</div>
        ` : ''}
      </div>
    </div>
    ` : ''}

    <!-- IDs (for debugging) -->
    <div class="zone-info-section zone-info-ids">
      <div class="zone-info-section-title">Identifiers</div>
      <div class="zone-info-row">
        <span class="zone-info-label">Managed ID</span>
        <span class="zone-info-value zone-info-mono zone-info-small">${s.id}</span>
      </div>
      ${s.claudeSessionId ? `
      <div class="zone-info-row">
        <span class="zone-info-label">Claude Session</span>
        <span class="zone-info-value zone-info-mono zone-info-small">${s.claudeSessionId}</span>
      </div>
      ` : ''}
    </div>
  `
}

function renderGitStatus(git: GitStatus): string {
  const stagedTotal = git.staged.added + git.staged.modified + git.staged.deleted
  const unstagedTotal = git.unstaged.added + git.unstaged.modified + git.unstaged.deleted
  const isDirty = stagedTotal > 0 || unstagedTotal > 0 || git.untracked > 0

  return `
    <div class="zone-info-section">
      <div class="zone-info-section-title">Git Status</div>

      <!-- Branch -->
      <div class="zone-info-git-branch">
        <span class="zone-info-branch-icon">⎇</span>
        <span class="zone-info-branch-name">${escapeHtml(git.branch)}</span>
        ${git.ahead > 0 ? `<span class="zone-info-branch-ahead">↑${git.ahead}</span>` : ''}
        ${git.behind > 0 ? `<span class="zone-info-branch-behind">↓${git.behind}</span>` : ''}
        ${isDirty ? `<span class="zone-info-branch-dirty">●</span>` : `<span class="zone-info-branch-clean">✓</span>`}
      </div>

      <!-- Changes -->
      ${stagedTotal > 0 ? `
      <div class="zone-info-git-changes">
        <span class="zone-info-changes-label">Staged</span>
        <span class="zone-info-changes-detail">
          ${git.staged.added > 0 ? `<span class="zone-info-added">+${git.staged.added}</span>` : ''}
          ${git.staged.modified > 0 ? `<span class="zone-info-modified">~${git.staged.modified}</span>` : ''}
          ${git.staged.deleted > 0 ? `<span class="zone-info-deleted">-${git.staged.deleted}</span>` : ''}
        </span>
      </div>
      ` : ''}

      ${unstagedTotal > 0 ? `
      <div class="zone-info-git-changes">
        <span class="zone-info-changes-label">Unstaged</span>
        <span class="zone-info-changes-detail">
          ${git.unstaged.added > 0 ? `<span class="zone-info-added">+${git.unstaged.added}</span>` : ''}
          ${git.unstaged.modified > 0 ? `<span class="zone-info-modified">~${git.unstaged.modified}</span>` : ''}
          ${git.unstaged.deleted > 0 ? `<span class="zone-info-deleted">-${git.unstaged.deleted}</span>` : ''}
        </span>
      </div>
      ` : ''}

      ${git.untracked > 0 ? `
      <div class="zone-info-git-changes">
        <span class="zone-info-changes-label">Untracked</span>
        <span class="zone-info-changes-detail zone-info-muted">${git.untracked} files</span>
      </div>
      ` : ''}

      ${!isDirty ? `
      <div class="zone-info-git-clean">Working tree clean</div>
      ` : ''}

      <!-- Lines changed -->
      ${(git.linesAdded > 0 || git.linesRemoved > 0) ? `
      <div class="zone-info-git-lines">
        ${git.linesAdded > 0 ? `<span class="zone-info-added">+${git.linesAdded}</span>` : ''}
        ${git.linesRemoved > 0 ? `<span class="zone-info-deleted">-${git.linesRemoved}</span>` : ''}
        <span class="zone-info-muted">lines</span>
      </div>
      ` : ''}

      <!-- Last commit -->
      ${git.lastCommitMessage ? `
      <div class="zone-info-git-commit">
        <span class="zone-info-commit-msg">${escapeHtml(git.lastCommitMessage)}</span>
        ${git.lastCommitTime ? `
        <span class="zone-info-commit-time">${formatTimeAgo(git.lastCommitTime * 1000)}</span>
        ` : ''}
      </div>
      ` : ''}
    </div>
  `
}

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return n.toString()
}

function shortenPath(path: string): string {
  // Show last 2-3 path segments
  const parts = path.split('/')
  if (parts.length <= 3) return path
  return '.../' + parts.slice(-3).join('/')
}

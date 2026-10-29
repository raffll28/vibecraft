/**
 * Parsers for captured tmux pane output (Claude Code's terminal UI).
 *
 * Pure functions (no server state), so they can be unit tested and swapped
 * out one at a time.
 */

import type { PermissionOption } from '../shared/types.js'

/**
 * Parse token count from Claude Code output
 * Patterns:
 *   ↓ 879 tokens
 *   ↓ 1,234 tokens
 *   ↓ 12.5k tokens
 *   ↓ 12k tokens
 */
export function parseTokensFromOutput(output: string): number | null {
  // Match patterns like: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
  const patterns = [
    /↓\s*([0-9,]+)\s*tokens?/gi,           // ↓ 879 tokens, ↓ 1,234 tokens
    /↓\s*([0-9.]+)k\s*tokens?/gi,          // ↓ 12.5k tokens, ↓ 12k tokens
  ]

  let maxTokens = 0

  // Pattern 1: plain numbers (possibly with commas)
  const plainMatches = output.matchAll(patterns[0])
  for (const match of plainMatches) {
    const num = parseInt(match[1].replace(/,/g, ''), 10)
    if (num > maxTokens) maxTokens = num
  }

  // Pattern 2: k suffix (thousands)
  const kMatches = output.matchAll(patterns[1])
  for (const match of kMatches) {
    const num = Math.round(parseFloat(match[1]) * 1000)
    if (num > maxTokens) maxTokens = num
  }

  return maxTokens > 0 ? maxTokens : null
}

/**
 * Parse tmux output to detect Claude Code permission prompts.
 *
 * Claude Code prompts look like:
 *   ● Bash(rm /tmp/test.txt)
 *   ⎿  Running PreToolUse hook…
 *   ─────────────────────────────
 *   Bash command
 *
 *      rm /tmp/test.txt
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and always allow access to tmp/ from this project
 *     3. No
 *
 *   Esc to cancel · Tab to add additional instructions
 *
 * OR (plan mode):
 *   · Bash(prompt: run TypeScript compiler)
 *   Would you like to proceed?
 *
 *     1. Yes, and bypass permissions
 *   ❯ 2. Yes, and manually approve edits
 *     3. Type here to tell Claude what to change
 *
 *   ctrl-g to edit in Vim · ~/.claude/plans/...
 */
export function detectPermissionPrompt(output: string): { tool: string; context: string; options: PermissionOption[] } | null {
  const lines = output.split('\n')

  // Look for "Do you want to proceed?" OR "Would you like to proceed?" in recent output
  let proceedLineIdx = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (/(Do you want|Would you like) to proceed\?/i.test(lines[i])) {
      proceedLineIdx = i
      break
    }
  }

  if (proceedLineIdx === -1) return null

  // CRITICAL: Verify this is a real Claude Code prompt by checking for the footer
  // "Esc to cancel · Tab to add additional instructions" OR "ctrl-g to edit in Vim"
  let hasFooter = false
  let hasSelector = false
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
      hasFooter = true
      break
    }
    // Also check for the ❯ selector arrow which indicates the interactive menu
    if (/^\s*❯/.test(lines[i])) {
      hasSelector = true
    }
  }

  // Must have either the footer or the selector arrow to be a real prompt
  if (!hasFooter && !hasSelector) {
    return null
  }

  // Parse numbered options below the "Do you want to proceed?" line
  const options: PermissionOption[] = []
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
    const line = lines[i]

    // Stop if we hit the footer
    if (/Esc to cancel/i.test(line)) break

    // Match options like "❯ 1. Yes" or "  2. Yes, and always..."
    // The arrow (❯) indicates current selection, but we want all options
    const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/)
    if (optionMatch) {
      options.push({
        number: optionMatch[1],
        label: optionMatch[2].trim()
      })
    }
  }

  // Need at least 2 options to be valid
  if (options.length < 2) return null

  // Find the tool name - look backwards for "● ToolName(...)" or "Bash command" header
  let tool = 'Unknown'
  for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
    // Match tool header like "● Bash(rm /tmp/test.txt)" or "· Bash(prompt: ...)"
    // ● = bullet, ◐ = half-filled circle, · = middle dot (plan mode)
    const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/)
    if (toolMatch) {
      tool = toolMatch[1]
      break
    }
    // Also match standalone tool type like "Bash command" or "Read file"
    const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i)
    if (cmdMatch) {
      tool = cmdMatch[1]
      break
    }
  }

  // Build context from the prompt area (between tool header and options)
  const contextStart = Math.max(0, proceedLineIdx - 10)
  const contextEnd = proceedLineIdx + 1 + options.length
  const context = lines.slice(contextStart, contextEnd).join('\n').trim()

  return { tool, context, options }
}

/**
 * Detect the bypass permissions warning that appears on first use of --dangerously-skip-permissions.
 * Returns true if the warning is detected and needs to be accepted.
 *
 * The warning looks like:
 *   ╭──────────────────────────────────────────────────────────────────────────────╮
 *   │                                  WARNING                                     │
 *   │                                                                              │
 *   │  You are entering Bypass Permissions mode. In this mode:                     │
 *   │   • All tool calls will be auto-approved                                     │
 *   │   ...                                                                        │
 *   │                                                                              │
 *   │  Are you sure you want to continue?                                          │
 *   │                                                                              │
 *   │      1. No, exit Claude Code                                                 │
 *   │    ❯ 2. Yes, I understand and accept the risks                               │
 *   ╰──────────────────────────────────────────────────────────────────────────────╯
 */
export function detectBypassWarning(output: string): boolean {
  // Must have both WARNING and Bypass Permissions mode
  return output.includes('WARNING') && output.includes('Bypass Permissions mode')
}

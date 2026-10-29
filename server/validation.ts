/**
 * Input validation and path helpers.
 *
 * Pure functions (no server state), so they can be unit tested and swapped
 * out one at a time.
 */

import { existsSync, statSync } from 'fs'
import { resolve } from 'path'

/** Expand ~ to home directory in paths */
export function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace('~', process.env.HOME || '')
  }
  return path
}

/**
 * Validate WebSocket origin header to prevent CSRF attacks.
 * Only browser clients should connect, so we require a valid origin.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Require origin header - only browsers send this
  if (!origin) return false

  try {
    const url = new URL(origin)

    // Allow any port on localhost/127.0.0.1 (local development)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return true
    }

    // Production: exact hostname match with HTTPS required
    if (url.hostname === 'vibecraft.sh' && url.protocol === 'https:') {
      return true
    }

    return false
  } catch {
    return false // Invalid URL format
  }
}

/**
 * Validate and sanitize a directory path for use in shell commands.
 * Returns the resolved path if valid, throws if invalid.
 */
export function validateDirectoryPath(inputPath: string): string {
  // Resolve to absolute path (handles ~, .., etc.)
  const resolved = resolve(expandHome(inputPath))

  // Check path exists and is a directory
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${inputPath}`)
  }

  const stat = statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`)
  }

  // Reject paths with shell metacharacters that could enable injection
  // Even with execFile, tmux passes commands to a shell
  const dangerousChars = /[;&|`$(){}[\]<>\\'"!#*?]/
  if (dangerousChars.test(resolved)) {
    throw new Error(`Directory path contains invalid characters: ${inputPath}`)
  }

  return resolved
}

/**
 * Validate a tmux session name.
 * tmux session names should only contain alphanumeric, underscore, hyphen.
 */
export function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`)
  }
  return name
}

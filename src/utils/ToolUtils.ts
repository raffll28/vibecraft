/**
 * ToolUtils - Pure utility functions for tool display
 *
 * These are stateless helpers used for rendering tool information
 * in the UI (context strings)
 */

import type { ToolInputSummary } from '../../shared/types.ts'

/**
 * Extract context string from tool input for display
 * Returns a short, human-readable summary of what the tool is operating on
 */
export function getToolContext(tool: string, input: ToolInputSummary): string | null {
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = input.file_path || input.notebook_path
      if (path) {
        // Show just filename or last path component
        return path.split('/').pop() || path
      }
      return null
    }
    case 'Bash': {
      const cmd = input.command
      if (cmd) {
        // Show first part of command
        const firstLine = cmd.split('\n')[0]
        return firstLine.length > 30 ? firstLine.slice(0, 30) + '...' : firstLine
      }
      return null
    }
    case 'Grep': {
      const pattern = input.pattern
      return pattern ? `/${pattern}/` : null
    }
    case 'Glob': {
      const pattern = input.pattern
      return pattern || null
    }
    case 'WebFetch': {
      const url = input.url
      if (url) {
        try {
          const hostname = new URL(url).hostname
          return hostname
        } catch {
          return url.slice(0, 30)
        }
      }
      return null
    }
    case 'WebSearch': {
      const query = input.query
      return query ? `"${query}"` : null
    }
    case 'Task': {
      const desc = input.description
      return desc || null
    }
    case 'TodoWrite':
      return 'Updating tasks'
    default:
      return null
  }
}

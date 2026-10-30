/**
 * Zone Notification Event Handlers
 *
 * Shows floating notifications above zones when tools complete.
 * Uses ZoneNotifications system for tool-specific styling.
 */

import { eventBus } from '../EventBus.ts'
import {
  formatFileChange,
  formatCommandResult,
  formatSearchResult,
} from '../../scene/ZoneNotifications.ts'
import type { PostToolUseEvent } from '../../../shared/types.ts'
import { getStationForTool } from '../../../shared/types.ts'

/**
 * Register notification-related event handlers
 */
export function registerNotificationHandlers(): void {
  // Tool completion notifications
  eventBus.on('post_tool_use', (event: PostToolUseEvent, ctx) => {
    if (!event.success || !ctx.scene) return

    const input = event.toolInput
    const fileName = input.file_path?.split('/').pop() || input.file_path
    let notificationText: string | null = null

    switch (event.tool) {
      case 'Edit': {
        if (fileName) {
          const { old_lines: oldLines, new_lines: newLines } = input
          notificationText = oldLines && newLines
            ? formatFileChange(fileName, {
              added: Math.max(0, newLines - oldLines),
              removed: Math.max(0, oldLines - newLines),
            })
            : fileName
        }
        break
      }
      case 'Write': {
        if (fileName) {
          notificationText = input.content_lines
            ? formatFileChange(fileName, { lines: input.content_lines })
            : fileName
        }
        break
      }
      case 'Read': {
        if (fileName) notificationText = fileName
        break
      }
      case 'Bash': {
        if (input.command) notificationText = formatCommandResult(input.command)
        break
      }
      case 'Grep':
      case 'Glob': {
        if (input.pattern) notificationText = formatSearchResult(input.pattern)
        break
      }
      case 'WebFetch':
      case 'WebSearch': {
        if (input.url) {
          // Extract domain from URL
          try {
            notificationText = new URL(input.url).hostname
          } catch {
            notificationText = input.url.slice(0, 30)
          }
        } else if (input.query) {
          notificationText = formatSearchResult(input.query)
        }
        break
      }
      case 'Task': {
        if (input.description) notificationText = input.description.slice(0, 25)
        break
      }
      case 'TodoWrite': {
        if (input.todo_count) notificationText = `${input.todo_count} items`
        break
      }
    }

    // Show notification using zone notifications system
    if (notificationText) {
      ctx.scene.zoneNotifications.showForTool(event.sessionId, event.tool, notificationText)

      // Also update station panels with tool history
      const station = getStationForTool(event.tool)
      if (station !== 'center') {
        ctx.scene.stationPanels.addToolUse(event.sessionId, station, {
          text: notificationText,
          success: event.success,
        })
      }
    }
  })
}

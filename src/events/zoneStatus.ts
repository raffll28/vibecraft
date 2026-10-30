/**
 * Zone status from Claude Code events: a traffic light per session.
 *
 *   idle (green)       free: finished, or waiting for the next prompt
 *   working (yellow)   busy: processing a prompt or running tools
 *   attention (red)    needs you: a permission prompt, a dialog, or a question
 *
 * Pure (no DOM or three.js), so it can be unit tested.
 */

import type { ClaudeEvent, NotificationEvent, PreToolUseEvent } from '../../shared/types.ts'

export type ZoneStatus = 'idle' | 'working' | 'attention'

/** Notification types that block Claude until the user acts */
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

/** The status an event puts its zone in, or null when it doesn't change it */
export function zoneStatusForEvent(event: ClaudeEvent): ZoneStatus | null {
  switch (event.type) {
    case 'pre_tool_use':
      // Claude asking a question waits for the answer
      return (event as PreToolUseEvent).tool === 'AskUserQuestion' ? 'attention' : 'working'
    case 'post_tool_use':
    case 'user_prompt_submit':
    case 'subagent_stop':
    case 'pre_compact':
      return 'working'
    case 'stop':
    case 'session_start':
      return 'idle'
    case 'notification': {
      const type = (event as NotificationEvent).notificationType
      if (BLOCKING_NOTIFICATIONS.has(type)) return 'attention'
      if (type === 'idle_prompt') return 'idle'
      return null
    }
    default:
      return null
  }
}

/**
 * Zone Status Event Handlers
 *
 * Keeps each zone's traffic light (see zoneStatus.ts) in sync with its
 * session's events. Red zones also pulse until the user acts.
 */

import { eventBus, type EventType } from '../EventBus'
import { zoneStatusForEvent } from '../zoneStatus'
import type { ClaudeEvent } from '../../../shared/types'

const STATUS_EVENTS: EventType[] = [
  'pre_tool_use',
  'post_tool_use',
  'user_prompt_submit',
  'subagent_stop',
  'pre_compact',
  'stop',
  'session_start',
  'notification',
]

/**
 * Register zone status event handlers
 */
export function registerZoneHandlers(): void {
  for (const type of STATUS_EVENTS) {
    eventBus.on(type, (event: ClaudeEvent, ctx) => {
      if (!ctx.session || !ctx.scene) return
      const status = zoneStatusForEvent(event)
      if (!status) return

      ctx.scene.setZoneStatus(event.sessionId, status)
      if (status === 'attention') {
        ctx.scene.setZoneAttention(event.sessionId, 'question')
      } else {
        ctx.scene.clearZoneAttention(event.sessionId)
      }
    })
  }
}

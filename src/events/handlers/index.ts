/**
 * Event Handlers - Barrel Export
 *
 * Import and call registerAllHandlers() to set up EventBus handlers.
 */

import { registerNotificationHandlers } from './notificationHandlers.ts'
import { registerCharacterHandlers } from './characterHandlers.ts'
import { registerSubagentHandlers } from './subagentHandlers.ts'
import { registerZoneHandlers } from './zoneHandlers.ts'
import { registerAnimationHandlers } from './animationHandlers.ts'

/**
 * Register all EventBus handlers
 * Call this once during app initialization
 */
export function registerAllHandlers(): void {
  registerNotificationHandlers()
  registerCharacterHandlers()
  registerSubagentHandlers()
  registerZoneHandlers()
  registerAnimationHandlers()
}

// Re-export individual registrations for testing
export {
  registerNotificationHandlers,
  registerCharacterHandlers,
  registerSubagentHandlers,
  registerZoneHandlers,
  registerAnimationHandlers,
}

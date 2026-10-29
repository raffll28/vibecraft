/**
 * Event Handlers - Barrel Export
 *
 * Import and call registerAllHandlers() to set up EventBus handlers.
 */

import { registerNotificationHandlers } from './notificationHandlers'
import { registerCharacterHandlers } from './characterHandlers'
import { registerSubagentHandlers } from './subagentHandlers'
import { registerZoneHandlers } from './zoneHandlers'
import { registerAnimationHandlers } from './animationHandlers'

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

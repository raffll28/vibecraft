/**
 * Character Animations - Barrel Export
 *
 * Import everything animation-related from here:
 *
 * ```typescript
 * import {
 *   // Types
 *   CharacterParts,
 *   IdleBehavior,
 *   WorkingBehavior,
 *   AnimationCategory,
 *
 *   // Easing functions
 *   easeInOut,
 *   easeOut,
 *   bounce,
 *
 *   // Utilities
 *   lerp,
 *   clamp,
 *   resetToDefaultPose,
 *
 *   // Managers
 *   IdleBehaviorManager,
 *   WorkingBehaviorManager,
 *
 *   // Registries
 *   IDLE_BEHAVIORS,
 *   STATION_ANIMATIONS,
 * } from './animations'
 * ```
 */

// Types and utilities
export * from './AnimationTypes.ts'

// Idle behaviors
export { IDLE_BEHAVIORS, IdleBehaviorManager } from './IdleBehaviors.ts'

// Working behaviors
export { STATION_ANIMATIONS, WorkingBehaviorManager } from './WorkingBehaviors.ts'

/**
 * ICharacter - Interface for swappable character models
 *
 * Any character model (Claude, ClaudeMon, future models) should implement this
 * interface to be drop-in replaceable in the workshop scene.
 */

import * as THREE from 'three'
import type { StationType } from '../../shared/types.ts'

export type CharacterState = 'idle' | 'walking' | 'working' | 'thinking'

export interface CharacterOptions {
  scale?: number
  color?: number
  statusColor?: number
  startStation?: StationType
  /** World position to start at (the start station's position in its zone) */
  startPosition?: THREE.Vector3
}

export interface ICharacter {
  /** The Three.js group containing all character meshes */
  readonly mesh: THREE.Group

  /** Current animation/behavior state */
  state: CharacterState

  /** Current station the character is at or heading to */
  currentStation: StationType

  /** Unique identifier for this character instance */
  readonly id: string

  /** Move character to a specific position */
  moveToPosition(position: THREE.Vector3, station: StationType): void

  /** Set the character's state (affects animation and status indicators) */
  setState(state: CharacterState): void

  /** Clean up resources when character is removed */
  dispose(): void
}

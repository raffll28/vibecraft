/**
 * WorkingBehaviors - Station-specific animations for ClaudeMon
 *
 * These animations play when Claude is "working" at a specific station.
 * Each station has its own contextual animation.
 *
 * To add a new station animation:
 * 1. Create a WorkingBehavior object
 * 2. Add it to STATION_ANIMATIONS with the station name as key
 */

import {
  type CharacterParts,
  type WorkingBehavior,
  easeInOut,
  easeOut,
} from './AnimationTypes.ts'

// Re-export for convenience
export type { WorkingBehavior } from './AnimationTypes.ts'

export type StationAnimations = {
  [station: string]: WorkingBehavior
}

// ============================================================================
// Station Working Animations
// ============================================================================

/** Bookshelf (Read) - Reading a book, flipping pages */
const readingBook: WorkingBehavior = {
  name: 'readingBook',
  loop: true,
  duration: 4,
  update: (parts, progress) => {
    // Hold arms like reading a book
    parts.leftArm.rotation.x = -1.2
    parts.leftArm.rotation.z = -0.3
    parts.rightArm.rotation.x = -1.2
    parts.rightArm.rotation.z = 0.3

    // Eyes scan left to right (reading)
    const readCycle = progress * 3  // 3 lines per cycle
    const lineProgress = readCycle % 1
    const eyeX = (lineProgress < 0.8)
      ? -0.02 + easeInOut(lineProgress / 0.8) * 0.04  // Read left to right
      : 0.02 - easeOut((lineProgress - 0.8) / 0.2) * 0.04  // Quick return

    parts.leftEye.position.x = -0.07 + eyeX
    parts.rightEye.position.x = 0.07 + eyeX

    // Slight head tilt while reading
    parts.head.rotation.x = 0.15  // Looking down at book
    parts.head.rotation.z = Math.sin(progress * Math.PI * 2) * 0.03

    // Occasional page flip (at progress 0.5)
    if (progress > 0.48 && progress < 0.55) {
      const flipProgress = (progress - 0.48) / 0.07
      parts.rightArm.rotation.z = 0.3 + Math.sin(flipProgress * Math.PI) * 0.4
    }
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.leftEye.position.x = -0.07
    parts.rightEye.position.x = 0.07
    parts.head.rotation.set(0, 0, 0)
  }
}

/** Workbench (Edit) - Using tools, tinkering */
const tinkering: WorkingBehavior = {
  name: 'tinkering',
  loop: true,
  duration: 2.5,
  update: (parts, progress) => {
    // One arm holds work, other arm uses tool
    parts.leftArm.rotation.x = -0.8
    parts.leftArm.rotation.z = -0.2

    // Right arm hammering/working motion
    const workCycle = progress * 4
    const hammerPhase = workCycle % 1
    const hammerMotion = Math.sin(hammerPhase * Math.PI) * 0.6
    parts.rightArm.rotation.x = -1.0 - hammerMotion
    parts.rightArm.rotation.z = 0.1

    // Head follows the work
    parts.head.rotation.x = 0.1
    parts.head.rotation.y = Math.sin(progress * Math.PI * 2) * 0.1

    // Body slight lean into work
    parts.body.rotation.x = 0.05

    // Eyes focused
    const focus = Math.sin(workCycle * Math.PI) * 0.01
    parts.leftEye.position.y = 0.03 + focus
    parts.rightEye.position.y = 0.03 + focus
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.head.rotation.set(0, 0, 0)
    parts.body.rotation.x = 0
    parts.leftEye.position.y = 0.03
    parts.rightEye.position.y = 0.03
  }
}

/** Desk (Write) - Writing, thinking, scratching head */
const writing: WorkingBehavior = {
  name: 'writing',
  loop: true,
  duration: 3,
  update: (parts, progress) => {
    // Writing arm motion
    const writeCycle = progress * 6
    const writePhase = writeCycle % 1

    // Right arm writing small movements
    parts.rightArm.rotation.x = -1.0
    parts.rightArm.rotation.z = 0.2 + Math.sin(writePhase * Math.PI * 2) * 0.15
    parts.rightArm.rotation.y = Math.sin(writePhase * Math.PI * 4) * 0.1

    // Left arm resting on desk
    parts.leftArm.rotation.x = -0.6
    parts.leftArm.rotation.z = -0.4

    // Head looking down at paper
    parts.head.rotation.x = 0.2

    // Occasional pause to think (every cycle)
    const thinkPause = Math.floor(writeCycle) % 3 === 2
    if (thinkPause && writePhase < 0.5) {
      parts.head.rotation.x = 0.05  // Look up thinking
      parts.head.rotation.z = 0.1
      parts.rightArm.rotation.x = -0.8  // Pause writing
    }

    // Eyes follow writing
    parts.leftEye.position.x = -0.07 + Math.sin(writePhase * Math.PI * 2) * 0.01
    parts.rightEye.position.x = 0.07 + Math.sin(writePhase * Math.PI * 2) * 0.01
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.head.rotation.set(0, 0, 0)
    parts.leftEye.position.x = -0.07
    parts.rightEye.position.x = 0.07
  }
}

/** Terminal (Bash) - Typing rapidly, looking at screen */
const typing: WorkingBehavior = {
  name: 'typing',
  loop: true,
  duration: 2,
  update: (parts, progress) => {
    // Both arms in typing position
    const typeCycle = progress * 12  // Fast typing
    const typePhase = typeCycle % 1

    // Alternating arm typing motions
    const leftType = Math.sin(typePhase * Math.PI * 2) * 0.1
    const rightType = Math.sin((typePhase + 0.5) * Math.PI * 2) * 0.1

    parts.leftArm.rotation.x = -0.7 + leftType
    parts.leftArm.rotation.z = -0.3
    parts.rightArm.rotation.x = -0.7 + rightType
    parts.rightArm.rotation.z = 0.3

    // Eyes scanning screen
    const scanX = Math.sin(progress * Math.PI * 4) * 0.02
    parts.leftEye.position.x = -0.07 + scanX
    parts.rightEye.position.x = 0.07 + scanX

    // Occasional head nod (understanding output)
    const nodCycle = Math.floor(progress * 4) % 4
    if (nodCycle === 3) {
      parts.head.rotation.x = Math.sin((progress * 4 % 1) * Math.PI) * 0.1
    }

    // Slight forward lean (focused)
    parts.body.rotation.x = 0.05
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.leftEye.position.x = -0.07
    parts.rightEye.position.x = 0.07
    parts.head.rotation.x = 0
    parts.body.rotation.x = 0
  }
}

/** Scanner (Grep/Glob) - Scanning, searching, peering */
const scanning: WorkingBehavior = {
  name: 'scanning',
  loop: true,
  duration: 3,
  update: (parts, progress) => {
    // Hand shading eyes, searching pose
    parts.rightArm.rotation.x = -2.0
    parts.rightArm.rotation.z = 0.5
    parts.rightArm.rotation.y = -0.3

    // Other arm at side or pointing
    const pointPhase = progress * 2
    if (Math.floor(pointPhase) % 2 === 1) {
      // Pointing at something found
      parts.leftArm.rotation.x = -1.5
      parts.leftArm.rotation.z = -0.3
    } else {
      parts.leftArm.rotation.x = 0
      parts.leftArm.rotation.z = 0
    }

    // Head scanning left to right
    const scanAngle = Math.sin(progress * Math.PI * 2) * 0.3
    parts.head.rotation.y = scanAngle

    // Eyes wide, searching
    parts.leftEye.scale.setScalar(1.1)
    parts.rightEye.scale.setScalar(1.1)

    // Eyes follow head direction
    parts.leftEye.position.x = -0.07 + scanAngle * 0.05
    parts.rightEye.position.x = 0.07 + scanAngle * 0.05

    // Slight body turn with head
    parts.body.rotation.y = scanAngle * 0.3
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.head.rotation.y = 0
    parts.body.rotation.y = 0
    parts.leftEye.scale.setScalar(1)
    parts.rightEye.scale.setScalar(1)
    parts.leftEye.position.x = -0.07
    parts.rightEye.position.x = 0.07
  }
}

/** Antenna (WebFetch/WebSearch) - Receiving signals, tuning */
const receiving: WorkingBehavior = {
  name: 'receiving',
  loop: true,
  duration: 2.5,
  update: (parts, progress) => {
    // Antenna actively receiving - wobbles and perks
    const signalStrength = Math.sin(progress * Math.PI * 8) * 0.3
    parts.antenna.rotation.z = signalStrength
    parts.antenna.rotation.x = -0.1 + Math.abs(signalStrength) * 0.2

    // Hand to "ear" (antenna) like listening
    parts.rightArm.rotation.x = -2.2
    parts.rightArm.rotation.z = 0.8
    parts.rightArm.rotation.y = 0.3

    // Other hand adjusting/tuning gesture
    const tunePhase = progress * 4
    parts.leftArm.rotation.x = -1.0
    parts.leftArm.rotation.z = -0.2 + Math.sin(tunePhase * Math.PI) * 0.2

    // Head tilted, listening
    parts.head.rotation.z = 0.15
    parts.head.rotation.y = 0.1

    // Eyes looking up at antenna/signal direction
    parts.leftEye.position.y = 0.03 + 0.01
    parts.rightEye.position.y = 0.03 + 0.01
  },
  reset: (parts) => {
    parts.antenna.rotation.set(0, 0, 0)
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.head.rotation.set(0, 0, 0)
    parts.leftEye.position.y = 0.03
    parts.rightEye.position.y = 0.03
  }
}

/** Portal (Task) - Mystical gestures, channeling energy */
const channeling: WorkingBehavior = {
  name: 'channeling',
  loop: true,
  duration: 3,
  update: (parts, progress) => {
    // Arms raised, channeling pose
    const channelPulse = Math.sin(progress * Math.PI * 4)

    parts.leftArm.rotation.x = -1.8 + channelPulse * 0.2
    parts.leftArm.rotation.z = -0.6
    parts.rightArm.rotation.x = -1.8 - channelPulse * 0.2
    parts.rightArm.rotation.z = 0.6

    // Hands circle slightly (channeling motion)
    const circlePhase = progress * Math.PI * 2
    parts.leftArm.rotation.y = Math.sin(circlePhase) * 0.3
    parts.rightArm.rotation.y = -Math.sin(circlePhase) * 0.3

    // Body slight sway
    parts.mesh.rotation.z = Math.sin(progress * Math.PI * 2) * 0.05

    // Head looking at portal (forward/up)
    parts.head.rotation.x = -0.1

    // Eyes glowing effect (scale pulse)
    const glowPulse = 1 + Math.sin(progress * Math.PI * 6) * 0.15
    parts.leftEye.scale.setScalar(glowPulse)
    parts.rightEye.scale.setScalar(glowPulse)

    // Antenna resonating
    parts.antenna.rotation.x = Math.sin(progress * Math.PI * 8) * 0.15
    parts.antenna.rotation.z = Math.sin(progress * Math.PI * 6) * 0.1
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.mesh.rotation.z = 0
    parts.head.rotation.x = 0
    parts.leftEye.scale.setScalar(1)
    parts.rightEye.scale.setScalar(1)
    parts.antenna.rotation.set(0, 0, 0)
  }
}

/** Taskboard (TodoWrite) - Checking items, pointing at board */
const checkingTasks: WorkingBehavior = {
  name: 'checkingTasks',
  loop: true,
  duration: 3.5,
  update: (parts, progress) => {
    const taskCycle = progress * 3  // Check 3 items
    const taskPhase = taskCycle % 1
    const taskIndex = Math.floor(taskCycle) % 3

    // Point at different board positions (high, mid, low)
    const boardY = [0.3, 0, -0.3][taskIndex]

    // Right arm pointing at board
    parts.rightArm.rotation.x = -1.5 + boardY * 0.5
    parts.rightArm.rotation.z = 0.3

    // Check motion (arm moves in checkmark)
    if (taskPhase > 0.6 && taskPhase < 0.9) {
      const checkProgress = (taskPhase - 0.6) / 0.3
      parts.rightArm.rotation.z = 0.3 + Math.sin(checkProgress * Math.PI) * 0.3
      parts.rightArm.rotation.x += Math.sin(checkProgress * Math.PI) * 0.2
    }

    // Left arm holding clipboard/list
    parts.leftArm.rotation.x = -1.0
    parts.leftArm.rotation.z = -0.4

    // Head follows pointing
    parts.head.rotation.x = -boardY * 0.15
    parts.head.rotation.y = 0.2

    // Nod when checking off
    if (taskPhase > 0.8) {
      parts.head.rotation.x += Math.sin((taskPhase - 0.8) * 5 * Math.PI) * 0.1
    }

    // Eyes scanning board
    parts.leftEye.position.y = 0.03 - boardY * 0.01
    parts.rightEye.position.y = 0.03 - boardY * 0.01
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.head.rotation.set(0, 0, 0)
    parts.leftEye.position.y = 0.03
    parts.rightEye.position.y = 0.03
  }
}

/** Generic working animation for unmapped stations */
const genericWorking: WorkingBehavior = {
  name: 'genericWorking',
  loop: true,
  duration: 2,
  update: (parts, progress) => {
    // Simple focused working pose
    parts.leftArm.rotation.x = -0.5
    parts.rightArm.rotation.x = -0.5

    // Slight body movement showing activity
    const activity = Math.sin(progress * Math.PI * 4) * 0.03
    parts.body.rotation.x = 0.05 + activity

    // Head slight movements (thinking)
    parts.head.rotation.y = Math.sin(progress * Math.PI * 2) * 0.1
    parts.head.rotation.z = Math.sin(progress * Math.PI * 3) * 0.05
  },
  reset: (parts) => {
    parts.leftArm.rotation.set(0, 0, 0)
    parts.rightArm.rotation.set(0, 0, 0)
    parts.body.rotation.x = 0
    parts.head.rotation.set(0, 0, 0)
  }
}

// ============================================================================
// Station to Animation Mapping
// ============================================================================

export const STATION_ANIMATIONS: StationAnimations = {
  bookshelf: readingBook,
  workbench: tinkering,
  desk: writing,
  terminal: typing,
  scanner: scanning,
  antenna: receiving,
  portal: channeling,
  taskboard: checkingTasks,
  center: genericWorking,  // Default for center station
}

// ============================================================================
// Working Behavior Manager
// ============================================================================

export class WorkingBehaviorManager {
  private currentBehavior: WorkingBehavior | null = null
  private behaviorProgress = 0
  private currentStation: string | null = null

  /**
   * Start a working animation for a specific station
   */
  start(station: string, parts: CharacterParts): void {
    // Stop current behavior if any
    if (this.currentBehavior) {
      this.currentBehavior.reset?.(parts)
    }

    // Get animation for this station
    this.currentBehavior = STATION_ANIMATIONS[station] ?? STATION_ANIMATIONS.center
    this.currentStation = station
    this.behaviorProgress = 0

    // Store original positions
    parts.mesh.userData.originalX = parts.mesh.position.x
    parts.mesh.userData.originalY = parts.mesh.position.y
  }

  /**
   * Stop the current working animation
   */
  stop(parts: CharacterParts): void {
    if (this.currentBehavior) {
      this.currentBehavior.reset?.(parts)
      this.currentBehavior = null
      this.currentStation = null
      this.behaviorProgress = 0
    }
  }

  /**
   * Update the working animation
   * @returns true if animation is playing
   */
  update(parts: CharacterParts, deltaTime: number): boolean {
    if (!this.currentBehavior) return false

    this.behaviorProgress += deltaTime / this.currentBehavior.duration

    // Loop the animation
    if (this.behaviorProgress >= 1) {
      if (this.currentBehavior.loop) {
        this.behaviorProgress = this.behaviorProgress % 1
      } else {
        this.stop(parts)
        return false
      }
    }

    this.currentBehavior.update(parts, this.behaviorProgress, deltaTime)
    return true
  }

  /**
   * Check if currently playing
   */
  isPlaying(): boolean {
    return this.currentBehavior !== null
  }

  /**
   * Get current station being animated
   */
  getCurrentStation(): string | null {
    return this.currentStation
  }

  /**
   * Get current behavior name
   */
  getCurrentBehaviorName(): string | null {
    return this.currentBehavior?.name ?? null
  }
}

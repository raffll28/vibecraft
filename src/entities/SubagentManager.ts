/**
 * SubagentManager - Manages subagent visualizations
 *
 * Tracks Task tool spawns and creates mini-Claude instances for each active subagent
 */

import type { WorkshopScene } from '../scene/WorkshopScene.ts'
import { Claude, type ClaudeOptions } from './Claude.ts'

export interface Subagent {
  id: string
  toolUseId: string
  claude: Claude
  spawnTime: number
  description?: string
}

// Different colors for subagents to distinguish them
const SUBAGENT_COLORS = [
  0x60a5fa, // Blue
  0x34d399, // Emerald
  0xf472b6, // Pink
  0xa78bfa, // Purple
  0xfbbf24, // Amber
  0x22d3ee, // Cyan
]

export class SubagentManager {
  private scene: WorkshopScene
  private subagents: Map<string, Subagent> = new Map()
  private colorIndex = 0

  constructor(scene: WorkshopScene) {
    this.scene = scene
  }

  /**
   * Spawn a new subagent when a Task tool starts
   */
  spawn(toolUseId: string, description?: string): Subagent {
    // Don't spawn duplicates
    if (this.subagents.has(toolUseId)) {
      return this.subagents.get(toolUseId)!
    }

    // Get next color
    const color = SUBAGENT_COLORS[this.colorIndex % SUBAGENT_COLORS.length]
    this.colorIndex++

    // Create mini-Claude at portal station
    const options: ClaudeOptions = {
      scale: 0.6, // Smaller than main Claude
      color: color,
      statusColor: color,
      startStation: 'portal',
    }

    const claude = new Claude(this.scene, options)
    claude.setState('thinking')

    // Offset position slightly so they don't overlap
    const offset = this.subagents.size * 0.5
    const angle = (this.subagents.size * Math.PI * 0.4) // Fan out
    claude.mesh.position.x += Math.sin(angle) * offset
    claude.mesh.position.z += Math.cos(angle) * offset

    const subagent: Subagent = {
      id: claude.id,
      toolUseId,
      claude,
      spawnTime: Date.now(),
      description,
    }

    this.subagents.set(toolUseId, subagent)
    console.log(`Subagent spawned: ${toolUseId}`, description)

    return subagent
  }

  /**
   * Remove a subagent when its Task completes
   */
  remove(toolUseId: string): void {
    const subagent = this.subagents.get(toolUseId)
    if (subagent) {
      subagent.claude.dispose()
      this.subagents.delete(toolUseId)
      console.log(`Subagent removed: ${toolUseId}`)
    }
  }

  /**
   * Get a subagent by toolUseId
   */
  get(toolUseId: string): Subagent | undefined {
    return this.subagents.get(toolUseId)
  }

  /**
   * Get all active subagents
   */
  getAll(): Subagent[] {
    return Array.from(this.subagents.values())
  }

  /**
   * Get count of active subagents
   */
  get count(): number {
    return this.subagents.size
  }

  /**
   * Clean up all subagents
   */
  dispose(): void {
    for (const subagent of this.subagents.values()) {
      subagent.claude.dispose()
    }
    this.subagents.clear()
  }
}

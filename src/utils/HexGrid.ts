/**
 * HexGrid - Hexagonal grid utilities for zone placement
 *
 * Uses pointy-top hexagonal layout with axial coordinates (q, r).
 * Provides coordinate conversions, occupancy tracking, and placement algorithms.
 *
 * Coordinate systems:
 * - Axial (q, r): Column and row in hex grid
 * - Cube (x, y, z): 3D representation where x + y + z = 0
 * - Cartesian (x, z): World space coordinates
 */

export interface HexCoord {
  q: number  // axial column
  r: number  // axial row
}

interface CubeCoord {
  x: number
  y: number
  z: number
}

// Direction vectors for the 6 neighbors (pointy-top, counterclockwise from east)
const HEX_DIRECTIONS: HexCoord[] = [
  { q: 1, r: 0 },   // east
  { q: 1, r: -1 },  // northeast
  { q: 0, r: -1 },  // northwest
  { q: -1, r: 0 },  // west
  { q: -1, r: 1 },  // southwest
  { q: 0, r: 1 },   // southeast
]

export class HexGrid {
  readonly hexRadius: number
  readonly spacing: number
  readonly hexWidth: number   // √3 * radius * spacing
  readonly hexHeight: number  // 2 * radius * spacing

  // Occupancy tracking: "q,r" → sessionId
  private occupied = new Map<string, string>()
  // Reverse lookup: sessionId → "q,r"
  private sessionToHex = new Map<string, string>()
  // Spiral counter for fallback placement
  private spiralIndex = 0

  constructor(hexRadius = 10, spacing = 1.1) {
    this.hexRadius = hexRadius
    this.spacing = spacing
    this.hexWidth = Math.sqrt(3) * hexRadius * spacing
    this.hexHeight = 2 * hexRadius * spacing
  }

  // ============================================================================
  // Coordinate Conversions
  // ============================================================================

  /**
   * Convert axial hex coordinates to world cartesian coordinates
   * Pointy-top orientation
   */
  axialToCartesian(hex: HexCoord): { x: number; z: number } {
    const x = this.hexWidth * (hex.q + hex.r / 2)
    const z = this.hexHeight * (3 / 4) * hex.r
    return { x, z }
  }

  /**
   * Convert world cartesian coordinates to fractional axial coordinates
   * Result needs rounding to get actual hex cell
   */
  cartesianToAxial(x: number, z: number): { q: number; r: number } {
    const r = z / (this.hexHeight * 0.75)
    const q = x / this.hexWidth - r / 2
    return { q, r }
  }

  /**
   * Round fractional axial coordinates to nearest hex center
   * Uses cube coordinate conversion for accurate rounding
   */
  roundToHex(q: number, r: number): HexCoord {
    // Convert to cube coordinates
    const cube = this.axialToCube({ q, r })

    // Round each component
    let rx = Math.round(cube.x)
    let ry = Math.round(cube.y)
    let rz = Math.round(cube.z)

    // Fix rounding errors - cube coords must sum to 0
    const dx = Math.abs(rx - cube.x)
    const dy = Math.abs(ry - cube.y)
    const dz = Math.abs(rz - cube.z)

    if (dx > dy && dx > dz) {
      rx = -ry - rz
    } else if (dy > dz) {
      ry = -rx - rz
    } else {
      rz = -rx - ry
    }

    // Convert back to axial
    return this.cubeToAxial({ x: rx, y: ry, z: rz })
  }

  /**
   * Convert cartesian to the nearest hex cell
   */
  cartesianToHex(x: number, z: number): HexCoord {
    const { q, r } = this.cartesianToAxial(x, z)
    return this.roundToHex(q, r)
  }

  // Cube ↔ Axial conversions (internal)
  private axialToCube(hex: HexCoord): CubeCoord {
    const x = hex.q
    const z = hex.r
    const y = -x - z
    return { x, y, z }
  }

  private cubeToAxial(cube: CubeCoord): HexCoord {
    return { q: cube.x, r: cube.z }
  }

  // ============================================================================
  // Hex Operations
  // ============================================================================

  /**
   * Get string key for a hex coordinate (for Map storage)
   */
  hexKey(hex: HexCoord): string {
    return `${hex.q},${hex.r}`
  }

  // ============================================================================
  // Occupancy Tracking
  // ============================================================================

  /**
   * Mark a hex as occupied by a session
   */
  occupy(hex: HexCoord, sessionId: string): void {
    const key = this.hexKey(hex)
    this.occupied.set(key, sessionId)
    this.sessionToHex.set(sessionId, key)
  }

  /**
   * Release a hex occupied by a session
   */
  release(sessionId: string): void {
    const key = this.sessionToHex.get(sessionId)
    if (key) {
      this.occupied.delete(key)
      this.sessionToHex.delete(sessionId)
    }
  }

  /**
   * Check if a hex is occupied
   */
  isOccupied(hex: HexCoord): boolean {
    return this.occupied.has(this.hexKey(hex))
  }

  /**
   * Get count of occupied hexes
   */
  get occupiedCount(): number {
    return this.occupied.size
  }

  // ============================================================================
  // Placement Algorithms
  // ============================================================================

  /**
   * Get next hex in spiral sequence (fallback for keyboard/API creation)
   * Maintains spiral pattern: center → ring 1 → ring 2 → ...
   */
  getNextInSpiral(): HexCoord {
    // Find next unoccupied hex in spiral order
    const maxIndex = 1000  // More than enough hexes

    for (let i = this.spiralIndex; i < maxIndex; i++) {
      const hex = this.indexToHexCoord(i)
      if (!this.isOccupied(hex)) {
        this.spiralIndex = i + 1  // Start here next time
        return hex
      }
    }

    // Fallback
    return { q: 0, r: 0 }
  }

  // ============================================================================
  // Internal: Spiral Generation
  // ============================================================================

  /**
   * Get all hexes in a ring at a given distance from center
   */
  private getHexesInRing(center: HexCoord, ring: number): HexCoord[] {
    if (ring === 0) return [center]

    const results: HexCoord[] = []

    // Start at "east" corner of ring
    let hex: HexCoord = {
      q: center.q + ring,
      r: center.r,
    }

    // Walk around the ring (6 sides, `ring` steps per side)
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        results.push({ ...hex })
        // Move to next hex along this side
        hex = {
          q: hex.q + HEX_DIRECTIONS[(side + 2) % 6].q,
          r: hex.r + HEX_DIRECTIONS[(side + 2) % 6].r,
        }
      }
    }

    return results
  }

  /**
   * Convert linear index to hex coordinate using spiral pattern
   * Index 0 = center, 1-6 = ring 1, 7-18 = ring 2, etc.
   */
  private indexToHexCoord(index: number): HexCoord {
    if (index === 0) return { q: 0, r: 0 }

    // Find which ring and position within ring
    let ring = 1
    let ringStart = 1

    while (ringStart + ring * 6 <= index) {
      ringStart += ring * 6
      ring++
    }

    const posInRing = index - ringStart
    const side = Math.floor(posInRing / ring)
    const posOnSide = posInRing % ring

    // Start position: east corner of this ring
    let q = ring
    let r = 0

    // Walk around to the start of the correct side
    for (let s = 0; s < side; s++) {
      q += HEX_DIRECTIONS[(s + 2) % 6].q * ring
      r += HEX_DIRECTIONS[(s + 2) % 6].r * ring
    }

    // Walk along the current side to the exact position
    q += HEX_DIRECTIONS[(side + 2) % 6].q * posOnSide
    r += HEX_DIRECTIONS[(side + 2) % 6].r * posOnSide

    return { q, r }
  }

  // ============================================================================
  // Debug Utilities
  // ============================================================================

}

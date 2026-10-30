/**
 * WorkshopScene - The main 3D environment
 *
 * A cozy workshop where Claude works at different stations
 * Supports multiple zones for multi-session visualization
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { StationType } from '../../shared/types.ts'
import { HexGrid } from '../utils/HexGrid.ts'
import { ZoneNotifications } from './ZoneNotifications.ts'
import { StationPanels } from './StationPanels.ts'
import type { ZoneStatus } from '../events/zoneStatus.ts'
import {
  addBookshelfDetails,
  addTerminalDetails,
  addAntennaDetails,
  addPortalDetails,
  addScannerDetails,
  addDeskDetails,
  addWorkbenchDetails,
  addTaskboardDetails,
} from './stations/index.ts'

export interface Station {
  type: StationType
  position: THREE.Vector3  // World position
  mesh: THREE.Group
  label: string
  contextSprite?: THREE.Sprite
}

export type AttentionReason = 'question' | null

/** Traffic light colors for zone status */
const STATUS_LIGHT: Record<ZoneStatus, number> = {
  idle: 0x22c55e,       // green: free
  working: 0xfacc15,    // yellow: busy
  attention: 0xef4444,  // red: needs the user
}

export interface Zone {
  id: string
  group: THREE.Group
  stations: Map<StationType, Station>
  platform: THREE.Mesh
  ring: THREE.Mesh
  floor: THREE.Mesh
  color: number
  position: THREE.Vector3
  label?: THREE.Sprite
  labelText?: string  // Name shown on the label (redrawn when the status changes)
  pulseIntensity: number // For activity pulse effect
  attentionReason: AttentionReason // Persistent attention state
  attentionTime: number // Time accumulator for attention pulse
  particles: THREE.Points
  particleVelocities: Float32Array
  status: ZoneStatus
  // Animation state for enter/exit transitions
  animationState?: 'entering' | 'exiting'
  animationProgress?: number // 0 to 1
}

export type CameraMode = 'focused' | 'overview' | 'follow-active'

// Zone colors for different sessions - ice/cyan theme
export const ZONE_COLORS = [
  0x4ac8e8, // Cyan (primary)
  0x60a5fa, // Blue
  0x22d3d8, // Teal
  0x4ade80, // Green
  0xa78bfa, // Purple
  0xfbbf24, // Orange
  0xf472b6, // Pink
  0xa3e635, // Lime
]

export class WorkshopScene {
  public scene: THREE.Scene
  public camera: THREE.PerspectiveCamera
  public renderer: THREE.WebGLRenderer
  public controls: OrbitControls

  // Multi-zone support
  public zones: Map<string, Zone> = new Map()
  public hexGrid: HexGrid  // Hex grid for zone placement
  private zoneColorIndex = 0  // For cycling through colors

  // Camera modes
  public cameraMode: CameraMode = 'focused'
  public focusedZoneId: string | null = null
  private onCameraModeChange: ((mode: CameraMode) => void) | null = null

  // Camera animation
  private cameraTargetPos = new THREE.Vector3()
  private cameraTargetLookAt = new THREE.Vector3()
  private cameraAnimating = false
  private readonly cameraLerpSpeed = 8 // Higher = faster animation

  private container: HTMLElement
  private animationId: number | null = null
  private onRenderCallbacks: Array<(delta: number) => void> = []
  private clock = new THREE.Clock()

  // FPS tracking
  private frameCount = 0
  private lastFpsUpdate = 0
  private fpsElement: HTMLElement | null = null

  // Frame throttling: full frame rate while the user interacts or the camera
  // moves, IDLE_FPS otherwise. The scene never fully stops (stations bob,
  // particles drift), so without this it renders at the display rate forever.
  private static readonly IDLE_FPS = 30
  private static readonly ACTIVE_WINDOW_MS = 2000
  private lastInteractionTime = 0
  private lastFrameTime = 0

  // Click pulse effects (ring expands, hex fades)
  private clickPulses: Array<{
    mesh: THREE.Mesh | THREE.Line
    age: number
    maxAge: number
    type?: 'ring' | 'hex' | 'ripple'
    delay?: number  // Delay before animation starts (for ripple effect)
    startOpacity?: number  // Peak opacity when flashing
    baseOpacity?: number  // Opacity to fade back to (matches permanent grid)
    highlightColor?: THREE.Color  // Color to flash to
    baseColor?: THREE.Color  // Color to fade back to
  }> = []

  // Station glow pulses (brief highlight when tool uses station)
  private stationPulses: Array<{
    ring: THREE.Mesh
    age: number
    maxAge: number
    baseOpacity: number
    peakOpacity: number
  }> = []

  // Zone notification system (new)
  public zoneNotifications: ZoneNotifications

  // Station info panels
  public stationPanels: StationPanels

  // Ambient floating particles
  private ambientParticles: THREE.Points | null = null
  private ambientParticleData: Array<{
    baseY: number
    phase: number
    speed: number
    radius: number
    angle: number
  }> = []

  // Time accumulator for animations
  private time = 0

  // World hex grid overlay
  private worldHexGrid: THREE.Group | THREE.LineSegments | null = null

  // Hex hover highlight
  private hoverHighlight: THREE.Line | null = null
  private hoverRaycaster = new THREE.Raycaster()
  private hoverMouse = new THREE.Vector2()

  // World grid size (number of hex rings from center)
  private gridRange = 20

  constructor(container: HTMLElement) {
    this.container = container

    // Scene - dark blue-black like ice cave
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x080c14)
    // No fog - allows viewing multiple zones without fadeout

    // Hex grid for zone placement (radius=10, spacing=1.0 for touching hexes)
    this.hexGrid = new HexGrid(10, 1.0)

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      500 // Far plane extended for multi-zone viewing
    )
    this.camera.position.set(8, 6, 8)
    this.camera.lookAt(0, 0, 0)

    // Renderer - optimized for performance
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // Disable for performance (can enable if needed)
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)) // Lower max
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.BasicShadowMap // Fastest shadow type
    container.appendChild(this.renderer.domElement)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.maxPolarAngle = Math.PI / 2.1
    this.controls.minDistance = 5
    this.controls.maxDistance = 150 // Extended for multi-zone overview
    this.controls.target.set(0, 0, 0)

    // Stop camera animation when user manually interacts with controls
    this.controls.addEventListener('start', () => {
      this.cameraAnimating = false
    })
    // Fires on input and while damping settles
    this.controls.addEventListener('change', this.markInteraction)

    // Setup
    this.setupLighting()
    this.createWorldFloor()  // Invisible, just for click detection
    this.createWorldHexGrid()
    this.createAmbientParticles()
    this.setupHoverHighlight()

    // Initialize zone notification system
    this.zoneNotifications = new ZoneNotifications(this.scene)

    // Initialize station panels
    this.stationPanels = new StationPanels(this.scene)

    // Handle resize
    window.addEventListener('resize', this.handleResize)
  }

  /**
   * Setup hex hover highlight effect
   */
  private setupHoverHighlight(): void {
    // Create hex outline for hover highlight
    const hexRadius = this.hexGrid.hexRadius
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2
      points.push(new THREE.Vector3(
        hexRadius * Math.cos(angle),
        0.03,
        hexRadius * Math.sin(angle)
      ))
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({
      color: 0x8eeeff,  // Light cyan
      transparent: true,
      opacity: 0.7,
    })

    this.hoverHighlight = new THREE.Line(geometry, material)
    this.hoverHighlight.visible = false
    this.scene.add(this.hoverHighlight)

    // Listen for mouse movement
    this.renderer.domElement.addEventListener('mousemove', this.handleHover)
    this.renderer.domElement.addEventListener('mouseleave', this.handleHoverLeave)
  }

  /** Keep rendering at full frame rate for a moment after user input */
  private markInteraction = (): void => {
    this.lastInteractionTime = performance.now()
  }

  private handleHover = (event: MouseEvent): void => {
    this.markInteraction()
    if (!this.hoverHighlight || !this.worldFloor) return

    const rect = this.renderer.domElement.getBoundingClientRect()
    this.hoverMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.hoverMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    this.hoverRaycaster.setFromCamera(this.hoverMouse, this.camera)
    const intersects = this.hoverRaycaster.intersectObject(this.worldFloor)

    if (intersects.length > 0) {
      const point = intersects[0].point
      const hexCoord = this.hexGrid.cartesianToHex(point.x, point.z)
      const hexCenter = this.hexGrid.axialToCartesian(hexCoord)

      this.hoverHighlight.position.set(hexCenter.x, 0, hexCenter.z)
      this.hoverHighlight.visible = true
    } else {
      this.hoverHighlight.visible = false
    }
  }

  private handleHoverLeave = (): void => {
    if (this.hoverHighlight) {
      this.hoverHighlight.visible = false
    }
  }

  /**
   * Create a new zone for a session
   * @param sessionId - Unique session identifier
   */
  createZone(sessionId: string): Zone {
    // Check if zone already exists
    const existing = this.zones.get(sessionId)
    if (existing) return existing

    // Next free hex in the honeycomb spiral
    const hexCoord = this.hexGrid.getNextInSpiral()

    // Mark hex as occupied
    this.hexGrid.occupy(hexCoord, sessionId)

    // Assign color and convert hex to world position
    const zoneColor = ZONE_COLORS[this.zoneColorIndex++ % ZONE_COLORS.length]
    const { x, z } = this.hexGrid.axialToCartesian(hexCoord)
    const position = new THREE.Vector3(x, 0, z)

    // Create zone group
    const group = new THREE.Group()
    group.position.copy(position)
    this.scene.add(group)

    // IMPORTANT: Update world matrix before creating stations
    // so localToWorld() returns correct world positions
    group.updateMatrixWorld(true)

    // Create zone platform/floor
    const { platform, ring, floor } = this.createZonePlatform(group, zoneColor)

    // Create stations in this zone
    const stations = this.createZoneStations(group, zoneColor)

    // Create floating session label
    const label = this.createZoneLabel(sessionId, zoneColor)
    label.position.set(0, 4, 0)
    group.add(label)

    // Create particle system for activity effects
    const { particles, velocities } = this.createParticleSystem(zoneColor)
    group.add(particles)

    const zone: Zone = {
      id: sessionId,
      group,
      stations,
      platform,
      ring,
      floor,
      color: zoneColor,
      position,
      label,
      pulseIntensity: 0,
      attentionReason: null,
      attentionTime: 0,
      particles,
      particleVelocities: velocities,
      status: 'idle',
      // Start animation
      animationState: 'entering',
      animationProgress: 0,
    }

    // Start with scale 0 for enter animation
    group.scale.setScalar(0.01)

    // Hide elements initially (they'll fade in)
    for (const station of stations.values()) {
      station.mesh.visible = false
    }
    if (label) label.visible = false
    particles.visible = false

    this.zones.set(sessionId, zone)

    // Register zone with notification system
    this.zoneNotifications.registerZone(sessionId, position)

    // Create station panels for this zone
    this.stationPanels.createPanelsForZone(sessionId, position)

    // Focus camera on first zone
    if (this.zones.size === 1) {
      this.focusZone(sessionId)
    }

    console.log(`Created zone for session ${sessionId.slice(0, 8)} at position`, position)
    return zone
  }

  /**
   * Delete a zone with exit animation
   */
  deleteZone(sessionId: string): boolean {
    const zone = this.zones.get(sessionId)
    if (!zone) return false

    // If already exiting, don't restart
    if (zone.animationState === 'exiting') return true

    // Start exit animation
    zone.animationState = 'exiting'
    zone.animationProgress = 0

    // Release hex position for reuse immediately (so new zones can use it)
    this.hexGrid.release(sessionId)

    console.log(`Starting exit animation for zone ${sessionId.slice(0, 8)}`)
    return true
  }

  /**
   * Actually remove a zone after animation completes
   */
  private finalizeZoneDelete(sessionId: string): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return

    // Unregister from notification system
    this.zoneNotifications.unregisterZone(sessionId)

    // Remove station panels
    this.stationPanels.removePanelsForZone(sessionId)

    // Remove from scene
    this.scene.remove(zone.group)

    // Dispose of geometries and materials
    zone.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose())
        } else if (obj.material) {
          obj.material.dispose()
        }
      } else if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose()
        obj.material.dispose()
      } else if (obj instanceof THREE.Points) {
        obj.geometry?.dispose()
        ;(obj.material as THREE.PointsMaterial)?.dispose()
      }
    })

    // Clean up label
    if (zone.label) {
      const material = zone.label.material as THREE.SpriteMaterial
      material.map?.dispose()
      material.dispose()
    }

    // Clean up context sprites from stations
    for (const station of zone.stations.values()) {
      if (station.contextSprite) {
        station.contextSprite.material.map?.dispose()
        station.contextSprite.material.dispose()
      }
    }

    this.zones.delete(sessionId)
    console.log(`Deleted zone for session ${sessionId.slice(0, 8)}`)

    // If we deleted the focused zone, unfocus
    if (this.focusedZoneId === sessionId) {
      this.focusedZoneId = null
    }
  }

  /**
   * Focus camera on a specific zone
   */
  focusZone(sessionId: string, animate = true): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return

    this.focusedZoneId = sessionId
    this.cameraMode = 'focused'

    const target = zone.position.clone()
    const cameraPos = target.clone().add(new THREE.Vector3(8, 6, 8))

    if (animate) {
      this.animateCameraTo(cameraPos, target)
    } else {
      this.controls.target.copy(target)
      this.camera.position.copy(cameraPos)
    }

    this.notifyCameraModeChange()
  }

  /**
   * Switch to bird's eye overview showing all zones
   */
  setOverviewMode(): void {
    this.cameraMode = 'overview'
    this.focusedZoneId = null

    // Calculate center and extent of all zones
    if (this.zones.size === 0) return

    let minX = Infinity, maxX = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (const zone of this.zones.values()) {
      minX = Math.min(minX, zone.position.x - 10)
      maxX = Math.max(maxX, zone.position.x + 10)
      minZ = Math.min(minZ, zone.position.z - 10)
      maxZ = Math.max(maxZ, zone.position.z + 10)
    }

    const centerX = (minX + maxX) / 2
    const centerZ = (minZ + maxZ) / 2
    const extentX = maxX - minX
    const extentZ = maxZ - minZ
    const extent = Math.max(extentX, extentZ, 30)

    // Position camera high above looking down
    const height = extent * 0.8
    const targetLookAt = new THREE.Vector3(centerX, 0, centerZ)
    const targetPos = new THREE.Vector3(centerX, height, centerZ + extent * 0.3)

    this.animateCameraTo(targetPos, targetLookAt)
    this.notifyCameraModeChange()
  }

  /**
   * Animate camera to a new position and look-at target
   */
  private animateCameraTo(position: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.cameraTargetPos.copy(position)
    this.cameraTargetLookAt.copy(lookAt)
    this.cameraAnimating = true
  }

  /**
   * Enable follow-active mode (camera follows activity)
   */
  setFollowActiveMode(): void {
    this.cameraMode = 'follow-active'
    this.notifyCameraModeChange()
  }

  /**
   * Get zone by index (for keyboard shortcuts)
   */
  getZoneByIndex(index: number): Zone | undefined {
    const zones = Array.from(this.zones.values())
    return zones[index]
  }

  /**
   * Register callback for camera mode changes
   */
  onCameraMode(callback: (mode: CameraMode) => void): void {
    this.onCameraModeChange = callback
  }

  private notifyCameraModeChange(): void {
    if (this.onCameraModeChange) {
      this.onCameraModeChange(this.cameraMode)
    }
  }

  /**
   * Create a pointy-top hexagon shape
   */
  private createHexagonShape(radius: number): THREE.Shape {
    const shape = new THREE.Shape()
    for (let i = 0; i < 6; i++) {
      // Pointy-top: start at 90 degrees (top point)
      const angle = (Math.PI / 3) * i - Math.PI / 2
      const x = radius * Math.cos(angle)
      const y = radius * Math.sin(angle)
      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()
    return shape
  }

  private createZonePlatform(group: THREE.Group, color: number): { platform: THREE.Mesh; ring: THREE.Mesh; floor: THREE.Mesh } {
    const hexRadius = 10

    // Zone floor hexagon - slightly brighter/more active than world
    const floorShape = this.createHexagonShape(hexRadius)
    const floorGeometry = new THREE.ShapeGeometry(floorShape)
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a2535,  // Slightly brighter blue - more "active"
      roughness: 0.7,
      metalness: 0.15,
      emissive: color,
      emissiveIntensity: 0.02,  // Subtle glow from zone color
    })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    group.add(floor)

    // Colored hex ring around zone (will pulse with activity)
    const outerShape = this.createHexagonShape(hexRadius)
    const innerShape = this.createHexagonShape(hexRadius - 0.5)
    outerShape.holes.push(innerShape as unknown as THREE.Path)
    const ringGeometry = new THREE.ShapeGeometry(outerShape)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    group.add(ring)

    // Center platform (keep as cylinder - looks like a pedestal)
    const platformGeometry = new THREE.CylinderGeometry(1, 1.2, 0.2, 6) // 6 sides for hex
    const platformMaterial = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.5,
      metalness: 0.3,
      emissive: color,
      emissiveIntensity: 0.1,
    })
    const platform = new THREE.Mesh(platformGeometry, platformMaterial)
    platform.position.y = 0.1
    platform.rotation.y = Math.PI / 6 // Align with hex
    platform.receiveShadow = true
    platform.castShadow = true
    group.add(platform)

    // No internal hex grid lines - zone floor is clean
    // World hex grid shows through conceptually

    return { platform, ring, floor }
  }

  /**
   * Create floating label for a zone
   */
  private createZoneLabel(sessionId: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    // Higher resolution for crisp text
    canvas.width = 512
    canvas.height = 96

    this.drawLabelShape(ctx, canvas.width, canvas.height, color, sessionId.slice(0, 8))

    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set(5, 1.2, 1)

    return sprite
  }

  /**
   * Draw glowing text label - no box, just text with glow effect, and a
   * status light (traffic light color) to the left of the text
   */
  private drawLabelShape(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    color: number,
    text: string,
    keybind?: string,
    statusColor?: number
  ): void {
    const colorHex = `#${color.toString(16).padStart(6, '0')}`

    // Clear
    ctx.clearRect(0, 0, width, height)

    // Setup text style
    ctx.font = '600 36px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Truncate if needed
    let displayText = text
    const maxWidth = width - 80
    let textWidth = ctx.measureText(displayText).width
    if (textWidth > maxWidth) {
      while (textWidth > maxWidth && displayText.length > 3) {
        displayText = displayText.slice(0, -1)
        textWidth = ctx.measureText(displayText + '…').width
      }
      displayText += '…'
    }

    // Build full label with keybind
    const fullText = keybind ? `${keybind}  ${displayText}` : displayText
    const centerX = width / 2
    const centerY = height / 2

    // Dark backdrop for readability (soft shadow, not a box)
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
    ctx.shadowBlur = 12
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
    ctx.fillText(fullText, centerX, centerY)
    ctx.fillText(fullText, centerX, centerY)  // Double for stronger shadow
    ctx.restore()

    // Colored glow - outer (big bloom)
    ctx.save()
    ctx.shadowColor = colorHex
    ctx.shadowBlur = 30
    ctx.fillStyle = colorHex
    ctx.globalAlpha = 0.3
    ctx.fillText(fullText, centerX, centerY)
    ctx.fillText(fullText, centerX, centerY)
    ctx.restore()

    // Colored glow - middle
    ctx.save()
    ctx.shadowColor = colorHex
    ctx.shadowBlur = 12
    ctx.fillStyle = colorHex
    ctx.globalAlpha = 0.5
    ctx.fillText(fullText, centerX, centerY)
    ctx.restore()

    // Colored glow - inner (tight)
    ctx.save()
    ctx.shadowColor = colorHex
    ctx.shadowBlur = 4
    ctx.fillStyle = colorHex
    ctx.globalAlpha = 0.8
    ctx.fillText(fullText, centerX, centerY)
    ctx.restore()

    // Main text - crisp white
    ctx.fillStyle = '#ffffff'
    ctx.fillText(fullText, centerX, centerY)

    // Status light left of the text
    if (statusColor !== undefined) {
      const statusHex = `#${statusColor.toString(16).padStart(6, '0')}`
      const dotX = Math.max(18, centerX - ctx.measureText(fullText).width / 2 - 26)
      ctx.save()
      ctx.shadowColor = statusHex
      ctx.shadowBlur = 18
      ctx.fillStyle = statusHex
      ctx.beginPath()
      ctx.arc(dotX, centerY, 13, 0, Math.PI * 2)
      ctx.fill()
      ctx.fill()  // Double for a stronger glow
      ctx.restore()
    }
  }

  /**
   * Update the floating label for a zone
   * @param keybind - Optional keybind string (1-6, Q-Y, A-H, Z-N) to show as badge
   */
  updateZoneLabel(sessionId: string, newLabel: string, keybind?: string): void {
    const zone = this.zones.get(sessionId)
    if (!zone || !zone.label) return
    zone.labelText = newLabel

    // Redraw the label with new text using shared drawing function
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    canvas.width = 512
    canvas.height = 96

    this.drawLabelShape(ctx, canvas.width, canvas.height, zone.color, newLabel, keybind, STATUS_LIGHT[zone.status])

    // Update texture
    const material = zone.label.material as THREE.SpriteMaterial
    if (material.map) {
      material.map.dispose()
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    material.map = texture
    material.needsUpdate = true
  }

  /**
   * Trigger activity pulse on a zone
   */
  pulseZone(sessionId: string): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return
    zone.pulseIntensity = 1.0

    // Spawn particles
    this.emitParticles(zone)

    // In follow-active mode, animate camera to active zone
    if (this.cameraMode === 'follow-active' && this.focusedZoneId !== sessionId) {
      this.focusedZoneId = sessionId
      const target = zone.position.clone()
      const cameraPos = target.clone().add(new THREE.Vector3(8, 6, 8))
      this.animateCameraTo(cameraPos, target)
    }
  }

  /**
   * Set attention state on a zone (persists until cleared)
   */
  setZoneAttention(sessionId: string, reason: AttentionReason): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return
    zone.attentionReason = reason
    zone.attentionTime = 0
  }

  /**
   * Clear attention state on a zone
   * Note: Call setZoneStatus() after this to update colors
   */
  clearZoneAttention(sessionId: string): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return
    zone.attentionReason = null
    zone.attentionTime = 0
    zone.ring.scale.setScalar(1)
    // Colors are controlled by setZoneStatus(), not here
  }

  /**
   * Set zone status - changes floor AND ring color to indicate state
   */
  setZoneStatus(sessionId: string, status: Zone['status']): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return

    zone.status = status
    const floorMat = zone.floor.material as THREE.MeshStandardMaterial
    const ringMat = zone.ring.material as THREE.MeshBasicMaterial

    // Traffic light: green free, yellow busy, red needs the user
    const statusColors: Record<Zone['status'], { emissive: number; intensity: number; ring: number; ringOpacity: number }> = {
      idle: { emissive: zone.color, intensity: 0.02, ring: STATUS_LIGHT.idle, ringOpacity: 0.45 },
      working: { emissive: STATUS_LIGHT.working, intensity: 0.06, ring: STATUS_LIGHT.working, ringOpacity: 0.55 },
      attention: { emissive: STATUS_LIGHT.attention, intensity: 0.10, ring: STATUS_LIGHT.attention, ringOpacity: 0.75 },
    }

    const colors = statusColors[status]

    // Update floor
    floorMat.emissive.setHex(colors.emissive)
    floorMat.emissiveIntensity = colors.intensity

    // Update ring to match (overrides attention pulse animation)
    ringMat.color.setHex(colors.ring)
    ringMat.opacity = colors.ringOpacity

    // Redraw the label so its status light matches
    if (zone.labelText !== undefined) {
      this.updateZoneLabel(sessionId, zone.labelText)
    }
  }

  /**
   * Pulse a station's ring to highlight tool activity
   * Creates a brief glow effect (0.3s fade-in, 0.5s hold, 0.5s fade-out)
   */
  pulseStation(sessionId: string, stationType: StationType): void {
    const zone = this.zones.get(sessionId)
    if (!zone) return

    const station = zone.stations.get(stationType)
    if (!station || stationType === 'center') return

    // Find the ring mesh in the station group (last child is typically the ring)
    let ring: THREE.Mesh | undefined
    station.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry instanceof THREE.RingGeometry) {
        ring = child
      }
    })

    if (!ring) return

    const ringMat = (ring as THREE.Mesh).material as THREE.MeshBasicMaterial
    const baseOpacity = ringMat.opacity

    // Don't add another pulse if already pulsing
    if (this.stationPulses.some(p => p.ring === ring)) return

    this.stationPulses.push({
      ring,
      age: 0,
      maxAge: 1.3, // 0.3s in + 0.5s hold + 0.5s out
      baseOpacity,
      peakOpacity: Math.min(1, baseOpacity + 0.5),
    })
  }

  /**
   * Create particle system for a zone
   */
  private createParticleSystem(color: number): { particles: THREE.Points; velocities: Float32Array } {
    const particleCount = 20
    const positions = new Float32Array(particleCount * 3)
    const velocities = new Float32Array(particleCount * 3)

    // Initialize all particles far below (truly hidden until emitted)
    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = 0
      positions[i * 3 + 1] = -1000 // Far below - won't render through floor
      positions[i * 3 + 2] = 0
      velocities[i * 3] = 0
      velocities[i * 3 + 1] = 0
      velocities[i * 3 + 2] = 0
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const material = new THREE.PointsMaterial({
      color: color,
      size: 0.15,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    const particles = new THREE.Points(geometry, material)
    return { particles, velocities }
  }

  /**
   * Emit particles from a zone
   */
  private emitParticles(zone: Zone): void {
    const positions = zone.particles.geometry.attributes.position.array as Float32Array
    const velocities = zone.particleVelocities

    // Find inactive particles and activate them
    let activated = 0
    for (let i = 0; i < positions.length / 3 && activated < 5; i++) {
      if (positions[i * 3 + 1] < -5) {
        // Spawn from center platform
        positions[i * 3] = (Math.random() - 0.5) * 2
        positions[i * 3 + 1] = 0.5
        positions[i * 3 + 2] = (Math.random() - 0.5) * 2

        // Random upward velocity with spread
        velocities[i * 3] = (Math.random() - 0.5) * 2
        velocities[i * 3 + 1] = 2 + Math.random() * 2
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 2

        activated++
      }
    }

    zone.particles.geometry.attributes.position.needsUpdate = true
  }

  /**
   * Create ambient floating particles for atmosphere
   */
  private createAmbientParticles(): void {
    const particleCount = 60
    const positions = new Float32Array(particleCount * 3)

    // Initialize particles in a smaller area above zones
    for (let i = 0; i < particleCount; i++) {
      const radius = 2 + Math.random() * 15  // Stay closer to center (2-17 units)
      const angle = Math.random() * Math.PI * 2
      const baseY = 6 + Math.random() * 12  // Float higher (6-18 units up)

      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = baseY
      positions[i * 3 + 2] = Math.sin(angle) * radius

      // Store particle data for animation
      this.ambientParticleData.push({
        baseY,
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.5,
        radius,
        angle,
      })
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const material = new THREE.PointsMaterial({
      color: 0x4ac8e8, // Cyan to match ice theme
      size: 0.12,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    this.ambientParticles = new THREE.Points(geometry, material)
    this.scene.add(this.ambientParticles)
  }

  /**
   * Update ambient particles - gentle floating motion
   */
  private updateAmbientParticles(delta: number): void {
    if (!this.ambientParticles) return

    const positions = this.ambientParticles.geometry.attributes.position.array as Float32Array

    for (let i = 0; i < this.ambientParticleData.length; i++) {
      const data = this.ambientParticleData[i]

      // Gentle circular drift
      data.angle += delta * 0.02 * data.speed

      // Float up and down
      const yOffset = Math.sin(this.time * data.speed + data.phase) * 1.5

      positions[i * 3] = Math.cos(data.angle) * data.radius
      positions[i * 3 + 1] = data.baseY + yOffset
      positions[i * 3 + 2] = Math.sin(data.angle) * data.radius
    }

    this.ambientParticles.geometry.attributes.position.needsUpdate = true
  }

  /**
   * Create all stations for a zone
   */
  private createZoneStations(group: THREE.Group, zoneColor: number): Map<StationType, Station> {
    const stations = new Map<StationType, Station>()

    const stationConfigs: Array<{
      type: StationType
      position: [number, number, number]
      label: string
      color: number
    }> = [
      { type: 'center', position: [0, 0, 0], label: 'Center', color: zoneColor },
      { type: 'bookshelf', position: [0, 0, -4], label: 'Library', color: 0x2a4a5a },      // Dark teal
      { type: 'desk', position: [4, 0, 0], label: 'Desk', color: 0x3a4a5a },              // Blue-gray
      { type: 'workbench', position: [-4, 0, 0], label: 'Workbench', color: 0x3a4a55 },   // Steel blue
      { type: 'terminal', position: [0, 0, 4], label: 'Terminal', color: 0x1a2a3a },      // Dark blue
      { type: 'scanner', position: [3, 0, -3], label: 'Scanner', color: 0x2a4a6a },       // Blue
      { type: 'antenna', position: [-3, 0, -3], label: 'Antenna', color: 0x3a5a6a },      // Teal
      { type: 'portal', position: [-3, 0, 3], label: 'Portal', color: 0x3a4a6a },         // Deep blue
      { type: 'taskboard', position: [3, 0, 3], label: 'Task Board', color: 0x3a4a5a },   // Blue-gray
    ]

    for (const config of stationConfigs) {
      const station = this.createStationInZone(group, config)
      stations.set(config.type, station)
    }

    return stations
  }

  /**
   * Create a single station within a zone group
   */
  private createStationInZone(
    zoneGroup: THREE.Group,
    config: { type: StationType; position: [number, number, number]; label: string; color: number }
  ): Station {
    const stationGroup = new THREE.Group()
    const [x, y, z] = config.position

    if (config.type === 'center') {
      stationGroup.position.set(x, y, z)
      zoneGroup.add(stationGroup)

      // Position is relative to zone, need world position for Claude
      const localPos = new THREE.Vector3(x, 0.3, z)
      const worldPos = localPos.clone()
      zoneGroup.localToWorld(worldPos)

      return {
        type: config.type,
        position: worldPos,
        mesh: stationGroup,
        label: config.label,
      }
    }

    // Base/table
    const baseGeometry = new THREE.BoxGeometry(1.5, 0.8, 1)
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: config.color,
      roughness: 0.7,
      metalness: 0.2,
    })
    const base = new THREE.Mesh(baseGeometry, baseMaterial)
    base.position.y = 0.4
    base.castShadow = true
    base.receiveShadow = true
    stationGroup.add(base)

    // Station-specific details (from modular station files)
    switch (config.type) {
      case 'bookshelf':
        addBookshelfDetails(stationGroup)
        break
      case 'desk':
        addDeskDetails(stationGroup)
        break
      case 'workbench':
        addWorkbenchDetails(stationGroup)
        break
      case 'terminal':
        addTerminalDetails(stationGroup)
        break
      case 'antenna':
        addAntennaDetails(stationGroup)
        break
      case 'portal':
        addPortalDetails(stationGroup)
        break
      case 'scanner':
        addScannerDetails(stationGroup)
        break
      case 'taskboard':
        addTaskboardDetails(stationGroup)
        break
    }

    // Station indicator ring
    const ringGeometry = new THREE.RingGeometry(0.9, 1, 32)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    stationGroup.add(ring)

    stationGroup.position.set(x, y, z)
    zoneGroup.add(stationGroup)

    // Calculate world position for Claude to stand
    const localPos = new THREE.Vector3(x, 0.3, z)
    const toCenter = new THREE.Vector3(-x, 0, -z).normalize()
    localPos.add(toCenter.multiplyScalar(1.2))

    const worldPos = localPos.clone()
    zoneGroup.localToWorld(worldPos)

    return {
      type: config.type,
      position: worldPos,
      mesh: stationGroup,
      label: config.label,
    }
  }

  private setupLighting(): void {
    // Ambient light - increased to compensate for fewer lights
    const ambient = new THREE.AmbientLight(0x606080, 0.8)
    this.scene.add(ambient)

    // Main directional light (sun) - reduced shadow map for performance
    const sun = new THREE.DirectionalLight(0xfff5e6, 1.2)
    sun.position.set(5, 10, 5)
    sun.castShadow = true
    sun.shadow.mapSize.width = 512  // Reduced from 2048
    sun.shadow.mapSize.height = 512
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 20
    sun.shadow.camera.left = -8
    sun.shadow.camera.right = 8
    sun.shadow.camera.top = 8
    sun.shadow.camera.bottom = -8
    this.scene.add(sun)

    // Hemisphere light for nice ambient fill (cheaper than point lights)
    const hemi = new THREE.HemisphereLight(0xfff5e6, 0x404060, 0.4)
    this.scene.add(hemi)
  }

  // World floor for empty-space click detection
  public worldFloor: THREE.Mesh | null = null

  /**
   * Create an invisible floor plane for click detection only
   * (hex grid provides the visual floor)
   */
  private createWorldFloor(): void {
    const floorGeometry = new THREE.PlaneGeometry(500, 500)
    const floorMaterial = new THREE.MeshBasicMaterial({
      visible: false,  // Invisible - just for raycasting
    })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.05
    floor.name = 'worldFloor'
    this.scene.add(floor)
    this.worldFloor = floor
  }

  /**
   * Create a world-level hex grid overlay
   * Renders subtle hex outlines across the floor to establish
   * the hex grid as the "base reality" of the world
   *
   * Uses merged geometry (single BufferGeometry with LineSegments)
   * for optimal performance - allows many more hexes with one draw call
   */
  private createWorldHexGrid(): void {
    const hexRadius = this.hexGrid.hexRadius
    const gridRange = this.gridRange

    // Collect ALL line segments into one array
    // LineSegments needs pairs: [start1, end1, start2, end2, ...]
    const vertices: number[] = []

    // Precompute hex corner angles (pointy-top orientation)
    const angles: number[] = []
    for (let i = 0; i < 6; i++) {
      angles.push((Math.PI / 3) * i - Math.PI / 2)
    }

    // Iterate through hex coordinates in range
    for (let q = -gridRange; q <= gridRange; q++) {
      for (let r = -gridRange; r <= gridRange; r++) {
        // Skip if too far from center (keep it roughly circular)
        // Uses cube coordinate constraint: |q| + |r| + |s| / 2 <= range
        if (Math.abs(q) + Math.abs(r) + Math.abs(-q - r) > gridRange * 2) continue

        const { x, z } = this.hexGrid.axialToCartesian({ q, r })

        // Add 6 line segments for this hex
        for (let i = 0; i < 6; i++) {
          const startAngle = angles[i]
          const endAngle = angles[(i + 1) % 6]

          // Start point
          vertices.push(
            x + hexRadius * Math.cos(startAngle),
            0,
            z + hexRadius * Math.sin(startAngle)
          )
          // End point
          vertices.push(
            x + hexRadius * Math.cos(endAngle),
            0,
            z + hexRadius * Math.sin(endAngle)
          )
        }
      }
    }

    // Create single merged geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))

    const material = new THREE.LineBasicMaterial({
      color: 0x4ac8e8,  // Cyan/ice blue
      transparent: true,
      opacity: 0.35,
    })

    // ONE LineSegments object instead of ~127 Lines
    const lines = new THREE.LineSegments(geometry, material)
    lines.position.y = 0.01  // Just above floor

    this.scene.add(lines)
    this.worldHexGrid = lines
  }

  // Station details moved to src/scene/stations/

  private handleResize = (): void => {
    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  onRender(callback: (delta: number) => void): void {
    this.onRenderCallbacks.push(callback)
  }

  offRender(callback: (delta: number) => void): void {
    const index = this.onRenderCallbacks.indexOf(callback)
    if (index !== -1) {
      this.onRenderCallbacks.splice(index, 1)
    }
  }

  start(): void {
    this.fpsElement = document.getElementById('fps')

    // Small tolerance so vsync jitter doesn't make us skip an extra frame
    const idleFrameInterval = 1000 / WorkshopScene.IDLE_FPS - 4

    const animate = () => {
      this.animationId = requestAnimationFrame(animate)

      const now = performance.now()
      const active = this.cameraAnimating ||
        now - this.lastInteractionTime < WorkshopScene.ACTIVE_WINDOW_MS
      if (!active && now - this.lastFrameTime < idleFrameInterval) return
      this.lastFrameTime = now

      const delta = this.clock.getDelta()

      // FPS counter
      this.frameCount++
      if (now - this.lastFpsUpdate >= 1000) {
        if (this.fpsElement) {
          this.fpsElement.textContent = `${this.frameCount} FPS`
        }
        this.frameCount = 0
        this.lastFpsUpdate = now
      }

      // Animate camera if needed
      if (this.cameraAnimating) {
        const lerpFactor = 1 - Math.exp(-this.cameraLerpSpeed * delta)

        this.camera.position.lerp(this.cameraTargetPos, lerpFactor)
        this.controls.target.lerp(this.cameraTargetLookAt, lerpFactor)

        // Stop animating when close enough
        const posDist = this.camera.position.distanceTo(this.cameraTargetPos)
        const targetDist = this.controls.target.distanceTo(this.cameraTargetLookAt)
        if (posDist < 0.01 && targetDist < 0.01) {
          this.camera.position.copy(this.cameraTargetPos)
          this.controls.target.copy(this.cameraTargetLookAt)
          this.cameraAnimating = false
        }
      }

      // Update controls
      this.controls.update()

      // Update time accumulator
      this.time += delta

      // Call render callbacks
      for (const callback of this.onRenderCallbacks) {
        callback(delta)
      }

      // Update ambient floating particles
      this.updateAmbientParticles(delta)

      // Update zone pulse effects and particles
      const zonesToFinalize: string[] = []
      for (const zone of this.zones.values()) {
        // Handle enter/exit animations
        if (zone.animationState === 'entering') {
          zone.animationProgress = Math.min(1, (zone.animationProgress ?? 0) + delta * 2) // 0.5 second animation

          // Ease out cubic for smooth deceleration
          const t = zone.animationProgress
          const eased = 1 - Math.pow(1 - t, 3)

          // Scale up the zone group
          zone.group.scale.setScalar(eased)

          // Fade in ring and floor
          const ringMat = zone.ring.material as THREE.MeshBasicMaterial
          const floorMat = zone.floor.material as THREE.MeshStandardMaterial
          ringMat.opacity = eased * 0.4
          floorMat.opacity = eased

          // Show stations and particles when mostly visible
          if (t > 0.5) {
            for (const station of zone.stations.values()) {
              station.mesh.visible = true
            }
            zone.particles.visible = true
          }

          // Show label at the end
          if (t > 0.7 && zone.label) {
            zone.label.visible = true
          }

          // Animation complete
          if (t >= 1) {
            zone.animationState = undefined
            zone.animationProgress = undefined
          }
        } else if (zone.animationState === 'exiting') {
          zone.animationProgress = Math.min(1, (zone.animationProgress ?? 0) + delta * 2.5) // 0.4 second animation

          // Ease in cubic for accelerating exit
          const t = zone.animationProgress
          const eased = 1 - Math.pow(t, 2)

          // Scale down
          zone.group.scale.setScalar(Math.max(0.01, eased))

          // Fade out ring and floor
          const ringMat = zone.ring.material as THREE.MeshBasicMaterial
          const floorMat = zone.floor.material as THREE.MeshStandardMaterial
          ringMat.opacity = eased * 0.4
          floorMat.opacity = eased

          // Hide elements early
          if (t > 0.3) {
            if (zone.label) zone.label.visible = false
            zone.particles.visible = false
          }
          if (t > 0.5) {
            for (const station of zone.stations.values()) {
              station.mesh.visible = false
            }
          }

          // Animation complete - mark for removal
          if (t >= 1) {
            zonesToFinalize.push(zone.id)
          }
        }

        // Station floating animation - gentle bob
        for (const station of zone.stations.values()) {
          if (station.type !== 'center') {
            const baseY = 0 // Stations sit on ground level
            const floatOffset = Math.sin(this.time * 1.5 + station.position.x * 0.5) * 0.03
            station.mesh.position.y = baseY + floatOffset
          }
        }

        // Ring pulse animation (color is controlled by setZoneStatus, this only animates opacity/scale)
        if (zone.attentionReason) {
          zone.attentionTime += delta

          const pulse = Math.sin(zone.attentionTime * 4) * 0.5 + 0.5
          zone.ring.scale.setScalar(1 + pulse * 0.08)
        } else if (zone.pulseIntensity > 0) {
          // Activity pulse (brief)
          zone.pulseIntensity = Math.max(0, zone.pulseIntensity - delta * 0.5)
          zone.ring.scale.setScalar(1 + zone.pulseIntensity * 0.05)
        } else {
          // No pulse - reset scale
          zone.ring.scale.setScalar(1)
        }

        // Update particles
        const positions = zone.particles.geometry.attributes.position.array as Float32Array
        const velocities = zone.particleVelocities
        let needsUpdate = false

        for (let i = 0; i < positions.length / 3; i++) {
          const y = positions[i * 3 + 1]
          if (y > -5) {
            // Apply velocity
            positions[i * 3] += velocities[i * 3] * delta
            positions[i * 3 + 1] += velocities[i * 3 + 1] * delta
            positions[i * 3 + 2] += velocities[i * 3 + 2] * delta

            // Apply gravity
            velocities[i * 3 + 1] -= 5 * delta

            // Fade out when falling
            if (positions[i * 3 + 1] < 0) {
              positions[i * 3 + 1] = -1000 // Hide far below
            }

            needsUpdate = true
          }
        }

        if (needsUpdate) {
          zone.particles.geometry.attributes.position.needsUpdate = true
        }
      }

      // Finalize any zones that finished exit animation
      for (const zoneId of zonesToFinalize) {
        this.finalizeZoneDelete(zoneId)
      }

      // Update click pulses
      this.updateClickPulses(delta)

      // Update station pulses
      this.updateStationPulses(delta)

      // Update zone notifications (new system)
      this.zoneNotifications.update(delta)

      // Update station panels
      this.stationPanels.update()

      // Render
      this.renderer.render(this.scene, this.camera)
    }

    animate()
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  /**
   * Create a text sprite for floating labels
   * Dynamically scales font size to fit long text
   */
  private createTextSprite(text: string, color = '#ffffff'): THREE.Sprite {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    // Size canvas for text
    canvas.width = 512
    canvas.height = 96
    const maxWidth = canvas.width - 60

    // Calculate optimal font size (start large, shrink to fit)
    let fontSize = 28
    const minFontSize = 14
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`

    while (ctx.measureText(text).width > maxWidth && fontSize > minFontSize) {
      fontSize -= 2
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`
    }

    // If still too wide, abbreviate
    let displayText = text
    if (ctx.measureText(text).width > maxWidth) {
      // For paths, show .../<parent>/<file>
      if (text.includes('/')) {
        const parts = text.split('/')
        if (parts.length >= 2) {
          displayText = '.../' + parts.slice(-2).join('/')
        } else {
          displayText = '.../' + parts.pop()
        }
      }
      // For commands, show beginning and end
      if (ctx.measureText(displayText).width > maxWidth) {
        const maxChars = Math.floor(maxWidth / (fontSize * 0.6))
        const half = Math.floor((maxChars - 3) / 2)
        displayText = text.slice(0, half) + '...' + text.slice(-half)
      }
    }

    const centerX = canvas.width / 2
    const centerY = canvas.height / 2

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Dark backdrop for readability
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
    ctx.shadowBlur = 10
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
    ctx.fillText(displayText, centerX, centerY)
    ctx.fillText(displayText, centerX, centerY)
    ctx.restore()

    // Colored glow - outer
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 20
    ctx.fillStyle = color
    ctx.globalAlpha = 0.4
    ctx.fillText(displayText, centerX, centerY)
    ctx.fillText(displayText, centerX, centerY)
    ctx.restore()

    // Colored glow - inner
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.fillStyle = color
    ctx.globalAlpha = 0.7
    ctx.fillText(displayText, centerX, centerY)
    ctx.restore()

    // Main text - white
    ctx.fillStyle = '#ffffff'
    ctx.fillText(displayText, centerX, centerY)

    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set(4, 0.8, 1)

    return sprite
  }

  /**
   * Set context text above a station in a specific zone
   */
  setStationContext(stationType: StationType, context: string | null, sessionId: string): void {
    const station = this.zones.get(sessionId)?.stations.get(stationType)
    if (!station) return

    // Remove existing context sprite
    if (station.contextSprite) {
      station.mesh.remove(station.contextSprite)
      station.contextSprite.material.map?.dispose()
      station.contextSprite.material.dispose()
      station.contextSprite = undefined
    }

    // Add new context if provided
    if (context) {
      const color = this.getStationColor(stationType)
      station.contextSprite = this.createTextSprite(context, color)
      station.contextSprite.position.set(0, 2.5, 0)
      station.mesh.add(station.contextSprite)
    }
  }

  /**
   * Clear all station contexts for a zone (or all zones if no sessionId)
   */
  clearAllContexts(sessionId?: string): void {
    if (sessionId) {
      const zone = this.zones.get(sessionId)
      if (!zone) return
      for (const [type] of zone.stations) {
        this.setStationContext(type, null, sessionId)
      }
    } else {
      // Clear all zones
      for (const [zoneId, zone] of this.zones) {
        for (const [type] of zone.stations) {
          this.setStationContext(type, null, zoneId)
        }
      }
    }
  }

  private getStationColor(type: StationType): string {
    const colors: Record<StationType, string> = {
      center: '#4ac8e8',    // Cyan (primary)
      bookshelf: '#fbbf24', // Orange/gold for books
      desk: '#4ade80',      // Green
      workbench: '#f97316', // Orange
      terminal: '#22d3ee',  // Cyan
      scanner: '#60a5fa',   // Blue
      antenna: '#4ac8e8',   // Cyan
      portal: '#22d3d8',    // Teal
      taskboard: '#fb923c', // Orange
    }
    return colors[type] || '#ffffff'
  }

  /**
   * Spawn a click pulse effect at a world position
   * Creates an expanding ring + hex wave that ripples outward
   *
   * IMPORTANT: This uses additive blending (THREE.AdditiveBlending) which is critical.
   *
   * Why previous approaches failed:
   * 1. Normal alpha blending with opacity fade: Our overlay would OBSCURE the permanent
   *    hex grid underneath as it faded. Even at low opacity, the overlay partially blocked
   *    the grid, making it appear darker than baseline. When removed, it "popped" back.
   *
   * 2. Trying to fade TO the grid's opacity (0.35): This caused stacking - our overlay
   *    at 0.35 + permanent grid at 0.35 = brighter than normal. Couldn't match baseline.
   *
   * 3. Creating all hexes upfront with delays: Even with opacity 0, adding geometry
   *    caused visual artifacts. Outer tiles would flicker before the wave reached them.
   *
   * Why this approach works:
   * - Additive blending only ADDS light, never obscures. At opacity 0, it contributes
   *   nothing, so the permanent grid shows through unchanged.
   * - depthWrite: false prevents z-fighting with the permanent grid at y=0.01
   * - setTimeout spawns each ring only when needed, not all at once
   * - Simple fade from peak to 0 with ease-out curve for smooth disappearance
   */
  spawnClickPulse(x: number, z: number, y = 0.03): void {
    const hexRadius = this.hexGrid.hexRadius
    const clickedHex = this.hexGrid.cartesianToHex(x, z)

    // 1. Expanding ring at click point
    const ringGeometry = new THREE.RingGeometry(0.2, 0.4, 32)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x8eefff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, y, z)
    this.scene.add(ring)

    this.clickPulses.push({
      mesh: ring,
      age: 0,
      maxAge: 0.5,
      type: 'ring',
    })

    // 2. Hex wave - spawn each ring over time
    const spawnHexRing = (ringNum: number, strength: number) => {
      const hexes = ringNum === 0 ? [clickedHex] : this.getHexRing(clickedHex, ringNum)

      for (const hex of hexes) {
        const center = this.hexGrid.axialToCartesian(hex)
        const points: THREE.Vector3[] = []
        for (let i = 0; i <= 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 2
          points.push(new THREE.Vector3(
            center.x + hexRadius * Math.cos(angle),
            0.02,
            center.z + hexRadius * Math.sin(angle)
          ))
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(points)
        const material = new THREE.LineBasicMaterial({
          color: 0x8eefff,
          transparent: true,
          opacity: strength,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
        const line = new THREE.Line(geometry, material)
        this.scene.add(line)

        this.clickPulses.push({
          mesh: line,
          age: 0,
          maxAge: 0.5,
          type: 'ripple',
          startOpacity: strength,
        })
      }
    }

    // Spawn rings with gentler decay so wave travels further
    const maxRings = 7
    const msPerRing = 45

    for (let r = 0; r <= maxRings; r++) {
      const strength = Math.pow(0.6, r)  // Gentler: 1.0 -> 0.6 -> 0.36 -> 0.22 -> 0.13 -> 0.08 -> 0.05 -> 0.03
      if (strength < 0.03) continue  // Skip if too dim
      if (r === 0) {
        spawnHexRing(0, strength)
      } else {
        setTimeout(() => spawnHexRing(r, strength), r * msPerRing)
      }
    }
  }

  /**
   * Get all hex coordinates in a ring at distance `ring` from center
   */
  private getHexRing(center: { q: number; r: number }, ring: number): Array<{ q: number; r: number }> {
    if (ring === 0) return [center]

    const results: Array<{ q: number; r: number }> = []
    const directions = [
      { q: 1, r: 0 },   { q: 1, r: -1 },  { q: 0, r: -1 },
      { q: -1, r: 0 },  { q: -1, r: 1 },  { q: 0, r: 1 },
    ]

    // Start at "east" corner
    let hex = { q: center.q + ring, r: center.r }

    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < ring; step++) {
        results.push({ ...hex })
        const dir = directions[(side + 2) % 6]
        hex = { q: hex.q + dir.q, r: hex.r + dir.r }
      }
    }

    return results
  }

  /**
   * Update click pulse animations (called from render loop)
   */
  private updateClickPulses(delta: number): void {
    for (let i = this.clickPulses.length - 1; i >= 0; i--) {
      const pulse = this.clickPulses[i]

      // Handle delay before animation starts
      if (pulse.delay && pulse.delay > 0) {
        pulse.delay -= delta
        continue  // Don't animate yet
      }

      pulse.age += delta
      const progress = pulse.age / pulse.maxAge

      if (progress >= 1) {
        // Remove finished pulse
        this.scene.remove(pulse.mesh)
        pulse.mesh.geometry.dispose()
        ;(pulse.mesh.material as THREE.Material).dispose()
        this.clickPulses.splice(i, 1)
      } else if (pulse.type === 'ring') {
        // Ring: expand and fade out
        const scale = 1 + progress * 4
        pulse.mesh.scale.set(scale, scale, 1)
        const opacity = 0.9 * (1 - progress * progress)
        ;(pulse.mesh.material as THREE.MeshBasicMaterial).opacity = opacity
      } else if (pulse.type === 'ripple') {
        // Ripple: appear at peak, fade to 0 with ease-out curve
        const material = pulse.mesh.material as THREE.LineBasicMaterial
        const peakOpacity = pulse.startOpacity ?? 1.0
        // Ease-out: stays bright early, fades smoothly to 0 at end
        const fade = Math.pow(1 - progress, 2)
        material.opacity = peakOpacity * fade
      } else {
        // Hex: pulse brightness then fade out
        const pulsePhase = Math.sin(progress * Math.PI * 2) * 0.3
        const fadeOut = 1 - progress * progress
        const opacity = Math.min(1, (0.7 + pulsePhase) * fadeOut)
        ;(pulse.mesh.material as THREE.LineBasicMaterial).opacity = opacity
      }
    }
  }

  /**
   * Update station pulse animations (called from render loop)
   */
  private updateStationPulses(delta: number): void {
    for (let i = this.stationPulses.length - 1; i >= 0; i--) {
      const pulse = this.stationPulses[i]
      pulse.age += delta
      const progress = pulse.age / pulse.maxAge

      if (progress >= 1) {
        // Animation complete - restore base opacity and remove
        const mat = pulse.ring.material as THREE.MeshBasicMaterial
        mat.opacity = pulse.baseOpacity
        this.stationPulses.splice(i, 1)
      } else {
        // Animate opacity: 0.3s fade in, 0.5s hold, 0.5s fade out
        const mat = pulse.ring.material as THREE.MeshBasicMaterial
        const fadeInEnd = 0.23  // 0.3 / 1.3
        const holdEnd = 0.62   // (0.3 + 0.5) / 1.3

        let opacity: number
        if (progress < fadeInEnd) {
          // Fade in
          const t = progress / fadeInEnd
          opacity = pulse.baseOpacity + (pulse.peakOpacity - pulse.baseOpacity) * t
        } else if (progress < holdEnd) {
          // Hold at peak
          opacity = pulse.peakOpacity
        } else {
          // Fade out
          const t = (progress - holdEnd) / (1 - holdEnd)
          opacity = pulse.peakOpacity - (pulse.peakOpacity - pulse.baseOpacity) * t
        }
        mat.opacity = opacity
      }
    }
  }

  // ============================================================================
  // Floating Notifications (file changes, etc.)
  // ============================================================================

  /**
   * Get current grid range (number of hex rings)
   */
  getGridRange(): number {
    return this.gridRange
  }

  /**
   * Set grid range and rebuild the world hex grid
   */
  setGridRange(range: number): void {
    // Clamp to reasonable values
    this.gridRange = Math.max(5, Math.min(80, range))

    // Remove old grid
    if (this.worldHexGrid) {
      this.scene.remove(this.worldHexGrid)
      if (this.worldHexGrid instanceof THREE.LineSegments) {
        this.worldHexGrid.geometry.dispose()
        ;(this.worldHexGrid.material as THREE.Material).dispose()
      }
      this.worldHexGrid = null
    }

    // Create new grid with updated range
    this.createWorldHexGrid()
  }

  dispose(): void {
    this.stop()
    this.clearAllContexts()
    // Clean up zone notifications (new system)
    this.zoneNotifications.dispose()
    // Clean up click pulses
    for (const pulse of this.clickPulses) {
      this.scene.remove(pulse.mesh)
      pulse.mesh.geometry.dispose()
      ;(pulse.mesh.material as THREE.MeshBasicMaterial).dispose()
    }
    this.clickPulses = []
    // Clean up hover highlight
    this.renderer.domElement.removeEventListener('mousemove', this.handleHover)
    this.renderer.domElement.removeEventListener('mouseleave', this.handleHoverLeave)
    window.removeEventListener('resize', this.handleResize)
    this.renderer.dispose()
    this.container.removeChild(this.renderer.domElement)
  }
}

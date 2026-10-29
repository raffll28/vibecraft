/**
 * Vibecraft - Main Entry Point
 *
 * A 3D monitor for the Claude Code sessions running in your terminals.
 * Each session gets a zone named after its directory, with a robot that
 * moves between workstations as Claude uses tools, and a status light:
 * green free, yellow busy, red needs you (see events/zoneStatus.ts).
 */

import './styles/index.css'
import * as THREE from 'three'
import { WorkshopScene, type Zone, type CameraMode } from './scene/WorkshopScene'
import { Claude } from './entities/ClaudeMon'      // Robot buddy character
import { SubagentManager } from './entities/SubagentManager'
import { EventClient } from './events/EventClient'
import { eventBus, type EventContext, type EventType } from './events/EventBus'
import { registerAllHandlers } from './events/handlers'
import type { ClaudeEvent, TextTile } from '../shared/types'
import { DEFAULTS } from '../shared/defaults'
import { ContextMenu, type ContextMenuContext } from './ui/ContextMenu'
import { setupKeyboardShortcuts } from './ui/KeyboardShortcuts'
import { drawMode } from './ui/DrawMode'
import { setupTextLabelModal, showTextLabelModal } from './ui/TextLabelModal'

// ============================================================================
// Configuration
// ============================================================================

// Injected by Vite at build time from shared/defaults.ts
declare const __VIBECRAFT_DEFAULT_PORT__: number

// Port configuration: URL param > localStorage > default from shared/defaults.ts
function getAgentPort(): number {
  const params = new URLSearchParams(window.location.search)
  const urlPort = params.get('port')
  if (urlPort) return parseInt(urlPort, 10)

  const storedPort = localStorage.getItem('vibecraft-agent-port')
  if (storedPort) return parseInt(storedPort, 10)

  return __VIBECRAFT_DEFAULT_PORT__
}

const AGENT_PORT = getAgentPort()

// In dev, Vite proxies /ws and /api to the server
const WS_URL = import.meta.env.DEV
  ? `ws://${window.location.host}/ws`
  : `ws://localhost:${AGENT_PORT}`

const API_URL = import.meta.env.DEV
  ? '/api'
  : `http://localhost:${AGENT_PORT}`

// ============================================================================
// State
// ============================================================================

/** Per-session state */
interface SessionState {
  claude: Claude
  subagents: SubagentManager
  zone: Zone
  color: number
  /** Zone label: the directory name, with " (2)" etc. for repeats */
  name: string
  stats: {
    toolsUsed: number
    filesTouched: Set<string>
    activeSubagents: number
  }
}

interface AppState {
  scene: WorkshopScene | null
  client: EventClient | null
  sessions: Map<string, SessionState>
  focusedSessionId: string | null  // Currently focused session for the camera
  hasAutoOverviewed: boolean  // Whether we've done initial auto-overview for 2+ sessions
  userChangedCamera: boolean  // Whether user has manually changed camera (to avoid overriding)
}

const state: AppState = {
  scene: null,
  client: null,
  sessions: new Map(),
  focusedSessionId: null,
  hasAutoOverviewed: false,
  userChangedCamera: false,
}

// ============================================================================
// Sessions and Zones
// ============================================================================

/**
 * Zone name for a session: its directory name, or "name (2)", "name (3)"...
 * when other live sessions already use it (the lowest free number is reused)
 */
function zoneNameFor(cwd: string, sessionId: string): string {
  const base = cwd.split('/').filter(Boolean).pop() || sessionId.slice(0, 8)
  const taken = new Set([...state.sessions.values()].map(s => s.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`
    if (!taken.has(name)) return name
  }
}

/**
 * Get or create the zone for an event's session. Returns null for events that
 * shouldn't create one: stale history, or a session that is ending.
 */
function getOrCreateSession(event: ClaudeEvent): SessionState | null {
  const sessionId = event.sessionId
  let session = state.sessions.get(sessionId)
  if (session) return session

  if (!state.scene) {
    throw new Error('Scene not initialized')
  }

  // Events older than this don't create zones (avoids reviving old history)
  const isRecent = Date.now() - event.timestamp < DEFAULTS.EXTERNAL_SESSION_MAX_AGE_MS
  if (!isRecent || event.type === 'session_end') {
    return null
  }

  const name = zoneNameFor(event.cwd, sessionId)
  const zone = state.scene.createZone(sessionId)
  state.scene.updateZoneLabel(sessionId, name)

  // Create Claude with matching color, positioned at zone center
  const claude = new Claude(state.scene, {
    color: zone.color,
    startStation: 'center',
  })

  // Position Claude at the zone's center station
  const centerStation = zone.stations.get('center')
  if (centerStation) {
    claude.mesh.position.copy(centerStation.position)
  }

  session = {
    claude,
    subagents: new SubagentManager(state.scene),
    zone,
    color: zone.color,
    name,
    stats: {
      toolsUsed: 0,
      filesTouched: new Set(),
      activeSubagents: 0,
    },
  }

  state.sessions.set(sessionId, session)
  console.log(`Created zone "${name}" for session ${sessionId.slice(0, 8)}`)

  // Focus on first session; show everything once there are several
  if (state.sessions.size === 1) {
    focusSession(sessionId)
  } else if (!state.hasAutoOverviewed && !state.userChangedCamera) {
    state.hasAutoOverviewed = true
    state.scene.setOverviewMode()
  }

  return session
}

/**
 * Remove a session's zone (when it ends, or when dismissed)
 */
function removeSession(sessionId: string): void {
  const session = state.sessions.get(sessionId)
  if (session) {
    session.claude.dispose()
    state.sessions.delete(sessionId)
  }
  if (state.scene?.zones.has(sessionId)) {
    state.scene.deleteZone(sessionId)
  }
  if (state.focusedSessionId === sessionId) {
    state.focusedSessionId = null
  }
}

/**
 * Focus camera on a specific session
 */
function focusSession(sessionId: string): void {
  const session = state.sessions.get(sessionId)
  if (!session || !state.scene) return

  state.focusedSessionId = sessionId
  state.scene.focusZone(sessionId)

  // Play a random idle animation when zone becomes active (if Claude is idle)
  if (session.claude.state === 'idle' && 'playRandomIdleBehavior' in session.claude) {
    (session.claude as { playRandomIdleBehavior: () => void }).playRandomIdleBehavior()
  }
}

// ============================================================================
// Event Handling
// ============================================================================

function handleEvent(event: ClaudeEvent) {
  const session = getOrCreateSession(event)

  // Character, subagents, notifications and the status light (EventBus handlers)
  const eventContext: EventContext = {
    scene: state.scene,
    session: session ? {
      id: event.sessionId,
      color: session.color,
      claude: session.claude,
      subagents: session.subagents,
      zone: session.zone,
      stats: session.stats,
    } : null,
  }
  eventBus.emit(event.type as EventType, event as any, eventContext)

  if (!session) return

  // Pulse the zone to indicate activity
  if (event.type === 'pre_tool_use' || event.type === 'user_prompt_submit') {
    state.scene?.pulseZone(event.sessionId)
  }

  switch (event.type) {
    case 'pre_tool_use': {
      const filePath = (event.toolInput as { file_path?: string }).file_path
      if (filePath) {
        session.stats.filesTouched.add(filePath)
      }
      break
    }

    case 'post_tool_use':
      session.stats.toolsUsed++
      break

    case 'session_start':
      session.stats.toolsUsed = 0
      session.stats.filesTouched.clear()
      break

    case 'session_end':
      removeSession(event.sessionId)
      break
  }
}

// ============================================================================
// Context Menu (text labels on the floor, dismissing zones)
// ============================================================================

let contextMenu: ContextMenu | null = null

function handleContextMenuAction(action: string, context: ContextMenuContext): void {
  if (action === 'delete' && context.zoneId) {
    removeSession(context.zoneId)
  } else if (action === 'create_text_tile' && context.hexPosition) {
    createTextTileAtHex(context.hexPosition as { q: number; r: number })
  } else if (action === 'edit_text_tile' && context.textTileId) {
    editTextTile(context.textTileId as string)
  } else if (action === 'delete_text_tile' && context.textTileId) {
    deleteTextTile(context.textTileId as string)
  }
}

/**
 * Create a text tile at a hex position (opens modal for text)
 */
async function createTextTileAtHex(hex: { q: number; r: number }): Promise<void> {
  const text = await showTextLabelModal({
    title: 'Add Label',
    placeholder: 'Enter your label text here...\nSupports multiple lines.',
  })
  if (!text?.trim()) return

  try {
    await fetch(`${API_URL}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        position: hex,
      }),
    })
  } catch (e) {
    console.error('Failed to create text tile:', e)
  }
}

/**
 * Edit an existing text tile
 */
async function editTextTile(tileId: string): Promise<void> {
  const tile = state.scene?.getTextTiles().find(t => t.id === tileId)
  if (!tile) return

  const text = await showTextLabelModal({
    title: 'Edit Label',
    placeholder: 'Enter your label text here...',
    initialText: tile.text,
  })
  if (text === null || text.trim() === tile.text) return

  try {
    await fetch(`${API_URL}/tiles/${tileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    })
  } catch (e) {
    console.error('Failed to update text tile:', e)
  }
}

/**
 * Delete a text tile
 */
async function deleteTextTile(tileId: string): Promise<void> {
  try {
    await fetch(`${API_URL}/tiles/${tileId}`, {
      method: 'DELETE',
    })
  } catch (e) {
    console.error('Failed to delete text tile:', e)
  }
}

function setupContextMenu(): void {
  contextMenu = new ContextMenu({
    onAction: handleContextMenuAction,
  })
}

// ============================================================================
// Mouse: focus zones, paint hexes, context menus
// ============================================================================

function setupMouseHandling(): void {
  if (!state.scene) return

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

  // Track mousedown position to distinguish clicks from drags
  let mouseDownPos: { x: number; y: number } | null = null
  const CLICK_THRESHOLD = 5  // pixels - if moved more than this, it's a drag

  // Draw mode drag painting state
  let isDrawModeDragging = false
  const paintedThisDrag = new Set<string>()  // Track hexes painted during current drag

  // Debounced save for hex art persistence (includes zone elevations)
  let hexArtSaveTimer: ReturnType<typeof setTimeout> | null = null
  const saveHexArt = () => {
    if (hexArtSaveTimer) clearTimeout(hexArtSaveTimer)
    hexArtSaveTimer = setTimeout(() => {
      if (!state.scene) return
      const hexes = state.scene.getPaintedHexes()
      const zoneElevations = state.scene.getZoneElevations()
      localStorage.setItem('vibecraft-hexart', JSON.stringify(hexes))
      localStorage.setItem('vibecraft-zone-elevations', JSON.stringify(zoneElevations))
      const elevCount = Object.keys(zoneElevations).length
      console.log(`Saved ${hexes.length} painted hexes and ${elevCount} zone elevations to localStorage`)
    }, 500)  // Debounce 500ms
  }

  // Helper to paint with brush size
  const paintWithBrush = (centerHex: { q: number; r: number }) => {
    if (!state.scene) return

    const brushSize = drawMode.getBrushSize()
    const color = drawMode.getSelectedColor()
    const hexesToPaint = state.scene.hexGrid.getHexesInRadius(centerHex, brushSize)

    let anyPainted = false
    for (const hex of hexesToPaint) {
      const hexKey = `${hex.q},${hex.r}`
      if (!paintedThisDrag.has(hexKey)) {
        paintedThisDrag.add(hexKey)
        if (color === null) {
          state.scene.clearPaintedHex(hex)
        } else {
          state.scene.paintHex(hex, color)
        }
        anyPainted = true
      }
    }

    // Save to localStorage (debounced)
    if (anyPainted) {
      saveHexArt()
    }
  }

  // Helper to convert mouse event to normalized coordinates and raycast
  const raycastFromMouse = (event: MouseEvent) => {
    const rect = state.scene!.renderer.domElement.getBoundingClientRect()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, state.scene!.camera)
  }

  // Helper to find which zone was clicked (returns sessionId or null)
  const findClickedZone = (): string | null => {
    for (const [sessionId, zone] of state.scene!.zones) {
      const intersects = raycaster.intersectObject(zone.group, true)
      if (intersects.length > 0) return sessionId
    }
    // Also check Claude meshes (they're not in the zone group)
    for (const [sessionId, session] of state.sessions) {
      const intersects = raycaster.intersectObject(session.claude.mesh, true)
      if (intersects.length > 0) return sessionId
    }
    return null
  }

  state.scene.renderer.domElement.addEventListener('mousedown', (event) => {
    mouseDownPos = { x: event.clientX, y: event.clientY }

    // Start draw mode drag painting
    if (drawMode.isEnabled() && event.button === 0) {
      isDrawModeDragging = true
      paintedThisDrag.clear()

      // Paint the initial hex(es) with brush
      raycastFromMouse(event)
      if (state.scene!.worldFloor) {
        const floorIntersects = raycaster.intersectObject(state.scene!.worldFloor)
        if (floorIntersects.length > 0) {
          const point = floorIntersects[0].point
          const hex = state.scene!.hexGrid.cartesianToHex(point.x, point.z)
          paintWithBrush(hex)
          // Spawn click pulse at zone elevation if clicking on a zone
          const zone = state.scene!.getZoneAtHex(hex)
          const pulseY = zone ? zone.elevation + 0.03 : 0.03
          state.scene!.spawnClickPulse(point.x, point.z, 0x4ac8e8, pulseY)
        }
      }
    }
  })

  // Stop draw mode dragging if mouse released anywhere (safety net)
  window.addEventListener('mouseup', () => {
    if (isDrawModeDragging) {
      isDrawModeDragging = false
      paintedThisDrag.clear()
    }
  })

  // Draw mode drag painting on mousemove
  state.scene.renderer.domElement.addEventListener('mousemove', (event) => {
    if (!state.scene || !isDrawModeDragging || !drawMode.isEnabled()) return

    raycastFromMouse(event)
    if (state.scene.worldFloor) {
      // Check both floor and painted hexes (for painting on top of existing)
      const floorIntersects = raycaster.intersectObject(state.scene.worldFloor)
      const paintedHexMeshes = state.scene.getPaintedHexMeshes()
      const paintedIntersects = paintedHexMeshes.length > 0
        ? raycaster.intersectObjects(paintedHexMeshes)
        : []

      const allIntersects = [...floorIntersects, ...paintedIntersects]
        .sort((a, b) => a.distance - b.distance)

      if (allIntersects.length > 0) {
        const point = allIntersects[0].point
        const hex = state.scene.hexGrid.cartesianToHex(point.x, point.z)
        paintWithBrush(hex)
      }
    }
  })

  // Left-click handler
  state.scene.renderer.domElement.addEventListener('mouseup', (event) => {
    // Stop draw mode dragging
    if (isDrawModeDragging) {
      isDrawModeDragging = false
      paintedThisDrag.clear()
    }

    if (!state.scene || !mouseDownPos) return

    // Check if this was a drag (mouse moved too much)
    const dx = event.clientX - mouseDownPos.x
    const dy = event.clientY - mouseDownPos.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    mouseDownPos = null

    if (distance > CLICK_THRESHOLD) {
      // This was a drag/pan, not a click - ignore
      return
    }

    raycastFromMouse(event)

    // In draw mode, skip zone/Claude focus - painting is handled in mousedown/mousemove
    if (drawMode.isEnabled()) {
      return
    }

    // Clicking anywhere in a zone (or on its Claude) focuses it
    const clickedZone = findClickedZone()
    if (clickedZone) {
      state.userChangedCamera = true
      focusSession(clickedZone)
      return
    }

    // Nothing was clicked - check if we hit the world floor or painted hexes
    // If so, show the text label menu
    if (state.scene.worldFloor) {
      // Check both floor and painted hexes (painted hexes block floor raycast)
      const floorIntersects = raycaster.intersectObject(state.scene.worldFloor)
      const paintedHexMeshes = state.scene.getPaintedHexMeshes()
      const paintedIntersects = paintedHexMeshes.length > 0
        ? raycaster.intersectObjects(paintedHexMeshes)
        : []

      // Use whichever hit is closest (painted hex is usually on top of floor)
      const allIntersects = [...floorIntersects, ...paintedIntersects]
        .sort((a, b) => a.distance - b.distance)

      if (allIntersects.length > 0) {
        const point = allIntersects[0].point
        const hex = state.scene.hexGrid.cartesianToHex(point.x, point.z)

        // Spawn visual pulse feedback at click location
        state.scene.spawnClickPulse(point.x, point.z)

        // Check if there's already a text tile at this position
        const existingTile = state.scene.getTextTileAtHex(hex)

        if (existingTile) {
          // Show edit/delete menu for existing text tile
          contextMenu?.show(
            event.clientX,
            event.clientY,
            [
              { key: 'E', label: `Edit "${existingTile.text}"`, action: 'edit_text_tile' },
              { key: 'D', label: 'Delete label', action: 'delete_text_tile', danger: true },
            ],
            { textTileId: existingTile.id }
          )
        } else {
          contextMenu?.show(
            event.clientX,
            event.clientY,
            [{ key: 'T', label: 'Add text label', action: 'create_text_tile' }],
            { hexPosition: hex }
          )
        }
      }
    }
  })

  // Right-click on a zone: dismiss it (it comes back with the session's next event)
  state.scene.renderer.domElement.addEventListener('contextmenu', (event) => {
    if (!state.scene) return
    event.preventDefault()  // Prevent browser context menu

    raycastFromMouse(event)
    const sessionId = findClickedZone()
    const session = sessionId ? state.sessions.get(sessionId) : undefined

    if (sessionId && session) {
      contextMenu?.show(
        event.clientX,
        event.clientY,
        [{ key: 'D', label: `Dismiss "${session.name}"`, action: 'delete', danger: true }],
        { zoneId: sessionId }
      )
    }
  })
}

/**
 * Update the keybind helper UI based on current camera mode
 */
function updateKeybindHelper(mode: CameraMode): void {
  const modeLabel = document.getElementById('camera-mode-label')
  const modeDesc = document.getElementById('camera-mode-desc')

  if (modeLabel && modeDesc) {
    switch (mode) {
      case 'focused':
        modeLabel.textContent = 'Focused'
        modeDesc.textContent = (state.focusedSessionId && state.sessions.get(state.focusedSessionId)?.name) || 'none'
        break
      case 'overview':
        modeLabel.textContent = 'Overview'
        modeDesc.textContent = 'all sessions'
        break
      case 'follow-active':
        modeLabel.textContent = 'Follow'
        modeDesc.textContent = 'auto-tracking'
        break
    }
  }
}

/**
 * Setup the dev panel for testing animations
 * Toggle with Alt+D
 */
function setupDevPanel(): void {
  const devPanel = document.getElementById('dev-panel')
  const animationsContainer = document.getElementById('dev-animations')
  if (!devPanel || !animationsContainer) return

  // Helper to get target Claude
  const getTargetClaude = (): InstanceType<typeof Claude> | null => {
    if (state.focusedSessionId) {
      const claude = state.sessions.get(state.focusedSessionId)?.claude
      if (claude) return claude
    }
    for (const session of state.sessions.values()) {
      return session.claude
    }
    return null
  }

  // We need to wait for a session to exist to get the behavior names
  const checkForSession = () => {
    let claude: InstanceType<typeof Claude> | null = null
    for (const session of state.sessions.values()) {
      claude = session.claude
      break
    }

    if (!claude) {
      setTimeout(checkForSession, 1000)
      return
    }

    animationsContainer.innerHTML = ''

    // --- Idle Behaviors Section ---
    const idleHeader = document.createElement('div')
    idleHeader.className = 'dev-section-header'
    idleHeader.textContent = 'Idle'
    animationsContainer.appendChild(idleHeader)

    const behaviors = claude.getIdleBehaviorNames()
    for (const name of behaviors) {
      const btn = document.createElement('button')
      btn.className = 'dev-anim-btn'
      btn.textContent = name
      btn.addEventListener('click', () => {
        const target = getTargetClaude()
        if (target) {
          target.playIdleBehavior(name)
          document.querySelectorAll('.dev-anim-btn').forEach(b => b.classList.remove('playing'))
          btn.classList.add('playing')
          setTimeout(() => btn.classList.remove('playing'), 2000)
        }
      })
      animationsContainer.appendChild(btn)
    }

    // --- Working Behaviors Section ---
    const workingHeader = document.createElement('div')
    workingHeader.className = 'dev-section-header'
    workingHeader.textContent = 'Working (by station)'
    animationsContainer.appendChild(workingHeader)

    const stations = claude.getWorkingBehaviorStations()
    for (const station of stations) {
      const btn = document.createElement('button')
      btn.className = 'dev-anim-btn dev-anim-btn-working'
      btn.textContent = station
      btn.addEventListener('click', () => {
        const target = getTargetClaude()
        if (target) {
          target.playWorkingBehavior(station)
          document.querySelectorAll('.dev-anim-btn').forEach(b => b.classList.remove('playing'))
          btn.classList.add('playing')
          // Working behaviors loop, so keep playing indicator longer
          setTimeout(() => btn.classList.remove('playing'), 4000)
        }
      })
      animationsContainer.appendChild(btn)
    }

    // --- Stop Button ---
    const stopBtn = document.createElement('button')
    stopBtn.className = 'dev-anim-btn dev-anim-btn-stop'
    stopBtn.textContent = '⏹ Stop → Idle'
    stopBtn.addEventListener('click', () => {
      const target = getTargetClaude()
      if (target) {
        target.setState('idle')
        document.querySelectorAll('.dev-anim-btn').forEach(b => b.classList.remove('playing'))
      }
    })
    animationsContainer.appendChild(stopBtn)
  }

  checkForSession()
}

// ============================================================================
// HUD and Settings
// ============================================================================

function updateStatus(connected: boolean, text?: string) {
  const dot = document.getElementById('status-dot')
  const textEl = document.getElementById('status-text')

  if (dot) {
    dot.className = connected ? 'connected' : ''
  }

  if (textEl) {
    // Only show text when disconnected or connecting
    if (!connected || text === 'Connecting...') {
      textEl.textContent = ` · ${text || 'Disconnected'}`
    } else {
      textEl.textContent = ''
    }
  }
}

async function fetchConfig() {
  try {
    const response = await fetch(`${API_URL}/config`)
    const data = await response.json()
    const usernameEl = document.getElementById('username')
    if (usernameEl && data.username) {
      usernameEl.textContent = data.username
    }
  } catch (e) {
    console.log('Could not fetch config:', e)
  }
}

/**
 * Setup settings modal
 */
function setupSettingsModal(): void {
  const settingsBtn = document.getElementById('settings-btn')
  const modal = document.getElementById('settings-modal')
  const closeBtn = document.getElementById('settings-close')
  const streamingCheckbox = document.getElementById('settings-streaming-mode') as HTMLInputElement | null
  const gridSizeSlider = document.getElementById('settings-grid-size') as HTMLInputElement | null
  const gridSizeValue = document.getElementById('settings-grid-size-value')

  if (!modal) return

  // Initialize draw mode UI
  drawMode.init()

  // Wire up draw mode clear callback
  drawMode.onClear(() => {
    state.scene?.clearAllPaintedHexes()
    // Clear from localStorage too
    localStorage.removeItem('vibecraft-hexart')
    localStorage.removeItem('vibecraft-zone-elevations')
    console.log('Cleared hex art and zone elevations from localStorage')
  })

  // Port input
  const portInput = document.getElementById('settings-port') as HTMLInputElement | null
  const portStatus = document.getElementById('settings-port-status')

  // Load saved grid size from localStorage
  const savedGridSize = localStorage.getItem('vibecraft-grid-size')
  if (savedGridSize !== null) {
    const size = parseInt(savedGridSize, 10)
    state.scene?.setGridRange(size)
    if (gridSizeSlider) gridSizeSlider.value = savedGridSize
    if (gridSizeValue) gridSizeValue.textContent = savedGridSize
  }

  // Load saved streaming mode setting from localStorage
  const savedStreaming = localStorage.getItem('vibecraft-streaming-mode')
  if (savedStreaming !== null) {
    const enabled = savedStreaming === 'true'
    if (streamingCheckbox) streamingCheckbox.checked = enabled
    applyStreamingMode(enabled)
  }

  // Apply streaming mode (hide/show username)
  function applyStreamingMode(enabled: boolean) {
    const usernameEl = document.getElementById('username')
    if (usernameEl) {
      if (enabled) {
        usernameEl.dataset.realName = usernameEl.textContent || ''
        usernameEl.textContent = '...'
      } else {
        usernameEl.textContent = usernameEl.dataset.realName || usernameEl.textContent
      }
    }
  }

  // Open modal
  settingsBtn?.addEventListener('click', () => {
    // Sync grid size slider
    if (gridSizeSlider && state.scene) {
      const currentSize = state.scene.getGridRange()
      gridSizeSlider.value = String(currentSize)
      if (gridSizeValue) gridSizeValue.textContent = String(currentSize)
    }
    // Sync streaming mode checkbox
    if (streamingCheckbox) {
      streamingCheckbox.checked = localStorage.getItem('vibecraft-streaming-mode') === 'true'
    }
    // Sync port input
    if (portInput) portInput.value = String(AGENT_PORT)
    // Update port status
    if (portStatus) {
      const connected = state.client?.isConnected ?? false
      portStatus.textContent = connected ? '● Connected' : '○ Disconnected'
      portStatus.className = `port-status ${connected ? 'connected' : 'disconnected'}`
    }
    modal.classList.add('visible')
  })

  // Close modal
  const closeModal = () => modal.classList.remove('visible')
  closeBtn?.addEventListener('click', closeModal)
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal()
  })

  // Grid size slider - rebuilds hex grid on change
  gridSizeSlider?.addEventListener('input', () => {
    const size = parseInt(gridSizeSlider.value, 10)
    if (gridSizeValue) gridSizeValue.textContent = String(size)
    state.scene?.setGridRange(size)
    localStorage.setItem('vibecraft-grid-size', String(size))
  })

  // Streaming mode checkbox
  streamingCheckbox?.addEventListener('change', () => {
    const enabled = streamingCheckbox.checked
    localStorage.setItem('vibecraft-streaming-mode', String(enabled))
    applyStreamingMode(enabled)
  })

  // Port change - save to localStorage and prompt refresh
  portInput?.addEventListener('change', () => {
    const newPort = parseInt(portInput.value, 10)
    if (newPort && newPort > 0 && newPort <= 65535 && newPort !== AGENT_PORT) {
      localStorage.setItem('vibecraft-agent-port', String(newPort))
      if (confirm(`Port changed to ${newPort}. Reload page to connect to new port?`)) {
        window.location.reload()
      }
    }
  })

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('visible')) {
      closeModal()
    }
  })
}

// ============================================================================
// Connection Overlay
// ============================================================================

function setupNotConnectedOverlay(): void {
  const overlay = document.getElementById('not-connected-overlay')
  document.getElementById('retry-connection')?.addEventListener('click', () => {
    window.location.reload()
  })
  document.getElementById('explore-offline')?.addEventListener('click', () => {
    overlay?.classList.remove('visible')
  })
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
  const container = document.getElementById('canvas-container')
  if (!container) {
    console.error('Canvas container not found')
    return
  }

  // Create scene (zones and Claudes created dynamically per session)
  state.scene = new WorkshopScene(container)

  // Load saved hex art from localStorage
  const savedHexArt = localStorage.getItem('vibecraft-hexart')
  if (savedHexArt) {
    try {
      const hexes = JSON.parse(savedHexArt)
      state.scene.loadPaintedHexes(hexes)
      console.log(`Loaded ${hexes.length} painted hexes from localStorage`)
    } catch (e) {
      console.warn('Failed to load hex art from localStorage:', e)
    }
  }

  // Load saved zone elevations from localStorage
  const savedZoneElevations = localStorage.getItem('vibecraft-zone-elevations')
  if (savedZoneElevations) {
    try {
      const elevations = JSON.parse(savedZoneElevations)
      state.scene.loadZoneElevations(elevations)
      console.log(`Loaded ${Object.keys(elevations).length} zone elevations from localStorage`)
    } catch (e) {
      console.warn('Failed to load zone elevations from localStorage:', e)
    }
  }

  // Start rendering
  state.scene.start()

  // Register EventBus handlers (decoupled event handling)
  registerAllHandlers()

  // Connect to event server
  state.client = new EventClient({
    url: WS_URL,
    debug: true,
  })

  // Track if we've ever connected
  let hasConnected = false

  state.client.onConnection((connected) => {
    updateStatus(connected, connected ? 'Connected' : 'Disconnected')
    if (connected) {
      hasConnected = true
      document.getElementById('not-connected-overlay')?.classList.remove('visible')
    }
  })

  // Show not-connected overlay after timeout if never connected (production only)
  if (!import.meta.env.DEV) {
    setTimeout(() => {
      if (!hasConnected) {
        document.getElementById('not-connected-overlay')?.classList.add('visible')
      }
    }, 3000)  // 3 seconds to connect before showing overlay
  }

  state.client.onEvent(handleEvent)
  state.client.onHistory((events) => {
    for (const event of events) {
      handleEvent(event)
    }
  })

  // Text labels on the floor
  state.client.onRawMessage((message) => {
    if (message.type === 'text_tiles') {
      state.scene?.setTextTiles(message.payload as TextTile[])
    }
  })

  state.client.connect()

  setupKeyboardShortcuts({
    getScene: () => state.scene,
    getFocusedSessionId: () => state.focusedSessionId,
    onFocusSession: focusSession,
    onSetUserChangedCamera: (value) => { state.userChangedCamera = value },
  })

  setupContextMenu()
  setupMouseHandling()

  // Register camera mode change callback
  state.scene.onCameraMode(updateKeybindHelper)

  // Register zone elevation change callback (to move Claude with zone)
  state.scene.onZoneElevation((sessionId, elevation) => {
    const session = state.sessions.get(sessionId)
    if (session) {
      // Update Claude's Y position to match zone elevation
      // The base station Y is 0.3 (from createZoneStations), so add that offset
      const stationYOffset = 0.3
      session.claude.mesh.position.y = elevation + stationYOffset
    }
  })

  fetchConfig()
  setupSettingsModal()
  setupDevPanel()
  setupTextLabelModal()
  setupNotConnectedOverlay()

  updateStatus(false, 'Connecting...')
  console.log('Vibecraft initialized')
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  state.client?.disconnect()
  // Dispose all sessions
  for (const session of state.sessions.values()) {
    session.claude.dispose()
  }
  state.sessions.clear()
  state.scene?.dispose()
}

// ============================================================================
// Start
// ============================================================================

window.addEventListener('load', init)
window.addEventListener('beforeunload', cleanup)

// Export for debugging
;(window as unknown as { vibecraft: AppState }).vibecraft = state

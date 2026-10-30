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
import { WorkshopScene, type Zone } from './scene/WorkshopScene.ts'
import { Claude } from './entities/ClaudeMon.ts'      // Robot buddy character
import { SubagentManager } from './entities/SubagentManager.ts'
import { EventClient } from './events/EventClient.ts'
import { eventBus, type EventContext, type EventType } from './events/EventBus.ts'
import { registerAllHandlers } from './events/handlers/index.ts'
import type { ClaudeEvent } from '../shared/types.ts'
import { DEFAULTS } from '../shared/defaults.ts'
import { ContextMenu, type ContextMenuContext } from './ui/ContextMenu.ts'
import { setupKeyboardShortcuts } from './ui/KeyboardShortcuts.ts'

// ============================================================================
// Configuration
// ============================================================================

// The page is served by vibecraft-server, which is also the WebSocket endpoint
const WS_URL = `ws://${location.host}`

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
  const isRecent = Date.now() - event.timestamp < DEFAULTS.SESSION_MAX_AGE_MS
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
    startPosition: zone.stations.get('center')?.position,
  })

  session = {
    claude,
    subagents: new SubagentManager(state.scene, zone),
    zone,
    color: zone.color,
    name,
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
    } : null,
  }
  eventBus.emit(event.type as EventType, event as any, eventContext)

  if (!session) return

  // Pulse the zone to indicate activity
  if (event.type === 'pre_tool_use' || event.type === 'user_prompt_submit') {
    state.scene?.pulseZone(event.sessionId)
  }

  if (event.type === 'session_end') {
    removeSession(event.sessionId)
  }
}

// ============================================================================
// Context Menu (dismissing zones)
// ============================================================================

let contextMenu: ContextMenu | null = null

function handleContextMenuAction(action: string, context: ContextMenuContext): void {
  if (action === 'delete' && context.zoneId) {
    removeSession(context.zoneId)
  }
}

function setupContextMenu(): void {
  contextMenu = new ContextMenu({
    onAction: handleContextMenuAction,
  })
}

// ============================================================================
// Mouse: focus zones, context menu
// ============================================================================

function setupMouseHandling(): void {
  if (!state.scene) return

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

  // Track mousedown position to distinguish clicks from drags
  let mouseDownPos: { x: number; y: number } | null = null
  const CLICK_THRESHOLD = 5  // pixels - if moved more than this, it's a drag

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
  })

  // Left-click handler
  state.scene.renderer.domElement.addEventListener('mouseup', (event) => {
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

    // Clicking anywhere in a zone (or on its Claude) focuses it
    const clickedZone = findClickedZone()
    if (clickedZone) {
      state.userChangedCamera = true
      focusSession(clickedZone)
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

// ============================================================================
// HUD
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

  // Show not-connected overlay after timeout if never connected
  setTimeout(() => {
    if (!hasConnected) {
      document.getElementById('not-connected-overlay')?.classList.add('visible')
    }
  }, 3000)  // 3 seconds to connect before showing overlay

  state.client.onEvent(handleEvent)
  state.client.onHistory((events) => {
    for (const event of events) {
      handleEvent(event)
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

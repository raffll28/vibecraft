/**
 * KeyboardShortcuts - Global keyboard shortcut handling
 *
 * Handles:
 * - 1-9: Focus zone 1-9 (in order of appearance)
 * - 0/`: Overview mode
 * - F: Follow mode toggle
 * - P: Station panels toggle
 * - D: Draw mode (1-6/0 colors, Q/E brush, R 3D, X clear, Esc exit)
 * - Alt+D: Dev panel toggle
 */

import type { WorkshopScene } from '../scene/WorkshopScene'
import { drawMode } from './DrawMode'

/** Zone shortcut keys, in zone order */
export const ZONE_KEYBINDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

// ============================================================================
// Types
// ============================================================================

export interface KeyboardShortcutContext {
  /** Get the workshop scene (may be null during init) */
  getScene: () => WorkshopScene | null

  /** Get currently focused session ID */
  getFocusedSessionId: () => string | null

  /** Callbacks */
  onFocusSession: (sessionId: string) => void
  onSetUserChangedCamera: (value: boolean) => void
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Setup global keyboard shortcuts
 */
export function setupKeyboardShortcuts(ctx: KeyboardShortcutContext): void {
  document.addEventListener('keydown', (e) => {
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    const isContextMenu = document.querySelector('.context-menu.visible') !== null
    const scene = ctx.getScene()
    if (!scene || inInput) return

    // ========================================================================
    // DRAW MODE HANDLING
    // ========================================================================

    // D key toggles draw mode (not in context menus)
    if (!isContextMenu && (e.key === 'd' || e.key === 'D') && !e.altKey && !e.ctrlKey) {
      e.preventDefault()
      drawMode.toggle()
      return
    }

    // Escape exits draw mode
    if (e.key === 'Escape' && drawMode.isEnabled()) {
      e.preventDefault()
      drawMode.exit()
      return
    }

    // In draw mode, 1-6 and 0 select colors instead of zones
    if (drawMode.isEnabled()) {
      if (drawMode.handleKey(e.key)) {
        e.preventDefault()
        return
      }

      // X or Backspace to clear all painted hexes
      if (e.key === 'x' || e.key === 'X' || e.key === 'Backspace') {
        e.preventDefault()
        scene.clearAllPaintedHexes()
        return
      }
    }

    // ========================================================================
    // NORMAL MODE HANDLING
    // ========================================================================

    // 1-9 focus a zone (its status light is left as it is)
    const zoneIndex = ZONE_KEYBINDS.indexOf(e.key)
    if (zoneIndex >= 0 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const zone = scene.getZoneByIndex(zoneIndex)
      if (zone) {
        ctx.onSetUserChangedCamera(true)
        scene.focusZone(zone.id)
        ctx.onFocusSession(zone.id)
      }
      return
    }

    // 0 or backtick for overview
    if (e.key === '0' || e.key === '`') {
      e.preventDefault()
      ctx.onSetUserChangedCamera(true)
      scene.setOverviewMode()
      return
    }

    // F for follow-active mode
    if (e.key === 'f' || e.key === 'F') {
      ctx.onSetUserChangedCamera(true)
      if (scene.cameraMode === 'follow-active') {
        // Toggle back to focused mode
        const focusedId = ctx.getFocusedSessionId()
        if (focusedId) {
          scene.focusZone(focusedId)
        }
      } else {
        scene.setFollowActiveMode()
      }
      return
    }

    // P for station panels toggle
    if (e.key === 'p' || e.key === 'P') {
      const visible = !scene.stationPanels.isVisible()
      scene.stationPanels.setVisible(visible)
      return
    }

    // Alt+D for dev panel toggle (animation testing)
    if (e.altKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      const devPanel = document.getElementById('dev-panel')
      if (devPanel) {
        devPanel.classList.toggle('hidden')
      }
      return
    }
  })
}

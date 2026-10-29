/**
 * Permission Modal - Tool permission request UI
 *
 * Displays permission prompts when Claude sessions run without
 * --dangerously-skip-permissions and need user approval for tools.
 */

import { escapeHtml } from './FeedManager'
import type { WorkshopScene } from '../scene/WorkshopScene'
import type { AttentionSystem } from '../systems/AttentionSystem'
import type { ManagedSession } from '../../shared/types'

// ============================================================================
// Types
// ============================================================================

export interface PermissionOption {
  number: string
  label: string
}

export interface PermissionData {
  sessionId: string
  tool: string
  context: string
  options: PermissionOption[]
}

export interface PermissionModalContext {
  scene: WorkshopScene | null
  apiUrl: string
  attentionSystem: AttentionSystem | null
  getManagedSessions: () => ManagedSession[]
}

// ============================================================================
// State
// ============================================================================

let currentPermission: PermissionData | null = null
let context: PermissionModalContext | null = null

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the permission modal with dependencies
 */
export function setupPermissionModal(ctx: PermissionModalContext): void {
  context = ctx

  const buttonsContainer = document.getElementById('permission-buttons')

  // Event delegation for dynamic buttons
  buttonsContainer?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.permission-btn') as HTMLElement
    if (btn) {
      const optionNumber = btn.dataset.option
      if (optionNumber) {
        sendPermissionResponse(optionNumber)
      }
    }
  })

  // Keyboard shortcuts - press the number key to select that option
  document.addEventListener('keydown', (e) => {
    if (!currentPermission) return

    // Number keys 1-9 to select options
    if (/^[1-9]$/.test(e.key)) {
      const option = currentPermission.options.find(o => o.number === e.key)
      if (option) {
        e.preventDefault()
        sendPermissionResponse(option.number)
      }
    }

    // NOTE: No Escape-to-close - user MUST select an option or the session stays hung
  })

  // NOTE: No click-outside-to-close - user MUST select an option
}

/**
 * Show the permission modal
 */
export function showPermissionModal(
  sessionId: string,
  tool: string,
  permContext: string,
  options: PermissionOption[]
): void {
  const modal = document.getElementById('permission-modal')
  const toolName = document.getElementById('permission-tool')
  const contextEl = document.getElementById('permission-context')
  const buttonsContainer = document.getElementById('permission-buttons')

  if (!modal || !buttonsContainer || !context) return

  currentPermission = { sessionId, tool, context: permContext, options }

  if (toolName) toolName.textContent = tool
  if (contextEl) contextEl.textContent = permContext

  // Generate buttons dynamically
  buttonsContainer.innerHTML = options.map(opt => `
    <button type="button" class="permission-btn" data-option="${opt.number}">
      <span class="permission-btn-num">${opt.number}</span>
      ${escapeHtml(opt.label)}
    </button>
  `).join('')

  // Show modal
  modal.classList.add('visible')

  // Set attention on the session's zone
  const managed = context.getManagedSessions().find(s => s.id === sessionId)
  if (managed?.claudeSessionId && context.scene) {
    context.scene.setZoneAttention(managed.claudeSessionId, 'question')
    context.scene.setZoneStatus(managed.claudeSessionId, 'attention')
  }

  // Add to attention queue
  context.attentionSystem?.add(sessionId)

}

/**
 * Hide the permission modal
 */
export function hidePermissionModal(): void {
  const modal = document.getElementById('permission-modal')
  modal?.classList.remove('visible')

  // Clear attention if we had one
  if (currentPermission && context) {
    const managed = context.getManagedSessions().find(s => s.id === currentPermission!.sessionId)
    if (managed?.claudeSessionId && context.scene) {
      context.scene.clearZoneAttention(managed.claudeSessionId)
      context.scene.setZoneStatus(managed.claudeSessionId, 'working')
    }
    context.attentionSystem?.remove(currentPermission.sessionId)
  }

  currentPermission = null
}

/**
 * Check if permission modal is currently shown
 */
export function isPermissionModalVisible(): boolean {
  return currentPermission !== null
}

// ============================================================================
// Internal
// ============================================================================

async function sendPermissionResponse(response: string): Promise<void> {
  if (!currentPermission || !context) return

  try {
    await fetch(`${context.apiUrl}/sessions/${currentPermission.sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    })
  } catch (e) {
    console.error('Failed to send permission response:', e)
  }

  hidePermissionModal()
}

/**
 * KeybindSettings - UI for editing keyboard shortcuts in settings modal
 */

import {
  keybindManager,
  formatKeybind,
  eventToKeybind,
  type Keybind,
  type KeybindAction,
} from './KeybindConfig'

let editingActionId: string | null = null
let editingElement: HTMLElement | null = null

/**
 * Setup keybind settings UI
 * Call this after DOM is ready
 */
export function setupKeybindSettings(): void {
  renderKeybindSettings()

  // Listen for changes to re-render
  keybindManager.onChange(() => {
    renderKeybindSettings()
  })

  // Global keydown listener for capturing new keybinds
  document.addEventListener('keydown', handleKeybindCapture, true)
}

/**
 * Render the keybind settings UI
 */
function renderKeybindSettings(): void {
  const container = document.getElementById('keybind-settings')
  if (!container) return

  const actions = keybindManager.getEditableActions()

  container.innerHTML = actions.map(action => `
    <div class="keybind-row" data-action-id="${action.id}">
      <span class="keybind-name">${action.name}</span>
      <div class="keybind-keys">
        ${action.bindings.map((binding, index) => `
          <button
            type="button"
            class="keybind-key${editingActionId === action.id ? ' editing' : ''}"
            data-action-id="${action.id}"
            data-binding-index="${index}"
            title="${action.description}"
          >${formatKeybind(binding)}</button>
        `).join('')}
        <button
          type="button"
          class="keybind-add"
          data-action-id="${action.id}"
          title="Add another keybind"
        >+</button>
      </div>
      <button
        type="button"
        class="keybind-reset"
        data-action-id="${action.id}"
        title="Reset to default"
      >↺</button>
    </div>
  `).join('')

  // Add click handlers
  container.querySelectorAll('.keybind-key').forEach(btn => {
    btn.addEventListener('click', handleKeybindClick)
  })

  container.querySelectorAll('.keybind-add').forEach(btn => {
    btn.addEventListener('click', handleAddKeybind)
  })

  container.querySelectorAll('.keybind-reset').forEach(btn => {
    btn.addEventListener('click', handleResetKeybind)
  })
}

/**
 * Handle click on a keybind button to start editing
 */
function handleKeybindClick(e: Event): void {
  const target = e.target as HTMLElement
  const actionId = target.dataset.actionId
  const bindingIndex = parseInt(target.dataset.bindingIndex || '0', 10)

  if (!actionId) return

  // If already editing this one, cancel
  if (editingActionId === actionId && editingElement === target) {
    cancelEditing()
    return
  }

  // Start editing
  editingActionId = actionId
  editingElement = target

  // Update UI to show editing state
  target.classList.add('editing')
  target.textContent = 'Press key...'
}

/**
 * Handle click on add button
 */
function handleAddKeybind(e: Event): void {
  const target = e.target as HTMLElement
  const actionId = target.dataset.actionId

  if (!actionId) return

  // Start editing for new keybind
  editingActionId = actionId
  editingElement = target

  target.classList.add('editing')
  target.textContent = 'Press key...'
}

/**
 * Handle click on reset button
 */
function handleResetKeybind(e: Event): void {
  const target = e.target as HTMLElement
  const actionId = target.dataset.actionId

  if (!actionId) return

  keybindManager.resetToDefaults(actionId)
}

/**
 * Handle keydown event during keybind capture
 */
function handleKeybindCapture(e: KeyboardEvent): void {
  if (!editingActionId || !editingElement) return

  // Escape cancels editing
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelEditing()
    return
  }

  // Ignore lone modifier keys
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
    return
  }

  e.preventDefault()
  e.stopPropagation()

  const newBinding = eventToKeybind(e)
  const actionId = editingActionId
  const isAddButton = editingElement.classList.contains('keybind-add')
  const bindingIndex = parseInt(editingElement.dataset.bindingIndex || '0', 10)

  // Get current bindings
  const currentBindings = [...keybindManager.getBindings(actionId)]

  if (isAddButton) {
    // Adding a new binding
    currentBindings.push(newBinding)
  } else {
    // Replacing existing binding
    currentBindings[bindingIndex] = newBinding
  }

  // Save and re-render
  keybindManager.setBindings(actionId, currentBindings)
  cancelEditing()
}

/**
 * Cancel editing mode
 */
function cancelEditing(): void {
  editingActionId = null
  editingElement = null
  renderKeybindSettings()
}

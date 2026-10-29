/**
 * Vibecraft Event Types
 *
 * These types define the contract between:
 * - Hook scripts (produce events)
 * - WebSocket server (relay events)
 * - Three.js client (consume events)
 */

// ============================================================================
// Core Event Types
// ============================================================================

export type HookEventType =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'subagent_stop'
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'notification'
  | 'pre_compact'

export type ToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Grep'
  | 'Glob'
  | 'WebFetch'
  | 'WebSearch'
  | 'Task'
  | 'TodoWrite'
  | 'AskUserQuestion'
  | 'NotebookEdit'
  | string // MCP tools and future tools

// ============================================================================
// Base Event
// ============================================================================

export interface BaseEvent {
  /** Unique event ID */
  id: string
  /** Unix timestamp in milliseconds */
  timestamp: number
  /** Event type */
  type: HookEventType
  /** Claude Code session ID */
  sessionId: string
  /** Current working directory */
  cwd: string
}

// ============================================================================
// Tool Events
// ============================================================================

export interface PreToolUseEvent extends BaseEvent {
  type: 'pre_tool_use'
  tool: ToolName
  toolInput: Record<string, unknown>
  toolUseId: string
  /** Assistant text that came before this tool call */
  assistantText?: string
}

export interface PostToolUseEvent extends BaseEvent {
  type: 'post_tool_use'
  tool: ToolName
  toolInput: Record<string, unknown>
  toolResponse: Record<string, unknown>
  toolUseId: string
  success: boolean
  /** Duration in milliseconds (calculated from matching pre_tool_use) */
  duration?: number
}

// ============================================================================
// Lifecycle Events
// ============================================================================

export interface StopEvent extends BaseEvent {
  type: 'stop'
  stopHookActive: boolean
  /** Claude's text response (extracted from transcript) */
  response?: string
}

export interface SubagentStopEvent extends BaseEvent {
  type: 'subagent_stop'
  stopHookActive: boolean
}

export interface SessionStartEvent extends BaseEvent {
  type: 'session_start'
  source: 'startup' | 'resume' | 'clear' | 'compact'
}

export interface SessionEndEvent extends BaseEvent {
  type: 'session_end'
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other'
}

// ============================================================================
// User Interaction Events
// ============================================================================

export interface UserPromptSubmitEvent extends BaseEvent {
  type: 'user_prompt_submit'
  prompt: string
}

export interface NotificationEvent extends BaseEvent {
  type: 'notification'
  message: string
  notificationType: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog' | string
}

// ============================================================================
// Other Events
// ============================================================================

export interface PreCompactEvent extends BaseEvent {
  type: 'pre_compact'
  trigger: 'manual' | 'auto'
  customInstructions?: string
}

// ============================================================================
// Union Type
// ============================================================================

export type ClaudeEvent =
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent
  | SubagentStopEvent
  | SessionStartEvent
  | SessionEndEvent
  | UserPromptSubmitEvent
  | NotificationEvent
  | PreCompactEvent

// ============================================================================
// WebSocket Messages
// ============================================================================

/** Server -> Client messages */
export type ServerMessage =
  | { type: 'event'; payload: ClaudeEvent }
  | { type: 'history'; payload: ClaudeEvent[] }
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'text_tiles'; payload: TextTile[] }

// ============================================================================
// Visualization State
// ============================================================================

/** Represents Claude's current activity state */
export type ClaudeState =
  | 'idle'           // Waiting for user input
  | 'thinking'       // Processing (between tools)
  | 'working'        // Using a tool
  | 'finished'       // Completed response

/** Station/location in the 3D workshop */
export type StationType =
  | 'center'         // Default idle position
  | 'bookshelf'      // Read
  | 'desk'           // Write
  | 'workbench'      // Edit
  | 'terminal'       // Bash
  | 'scanner'        // Grep/Glob
  | 'antenna'        // WebFetch/WebSearch
  | 'portal'         // Task (spawning subagents)
  | 'taskboard'      // TodoWrite

/** Map tools to stations */
export const TOOL_STATION_MAP: Record<ToolName, StationType> = {
  Read: 'bookshelf',
  Write: 'desk',
  Edit: 'workbench',
  Bash: 'terminal',
  Grep: 'scanner',
  Glob: 'scanner',
  WebFetch: 'antenna',
  WebSearch: 'antenna',
  Task: 'portal',
  TodoWrite: 'taskboard',
  AskUserQuestion: 'center',
  NotebookEdit: 'desk',
}

/** Get station for a tool (handles unknown/MCP tools) */
export function getStationForTool(tool: string): StationType {
  return TOOL_STATION_MAP[tool as ToolName] ?? 'center'
}

// ============================================================================
// Utility Types
// ============================================================================

/** Extract specific tool input types */
export interface BashToolInput {
  command: string
  description?: string
  timeout?: number
  run_in_background?: boolean
}

// ============================================================================
// Text Tiles (Grid Labels)
// ============================================================================

/** A text label tile on the hex grid */
export interface TextTile {
  /** Unique ID (UUID) */
  id: string
  /** The label text */
  text: string
  /** Hex grid position */
  position: {
    q: number
    r: number
  }
  /** Optional color (hex string, default white) */
  color?: string
  /** Creation timestamp */
  createdAt: number
}

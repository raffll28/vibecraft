/**
 * Vibecraft Event Types
 *
 * These types define the contract between:
 * - the hook (rust/vibecraft-hook/src/event.rs), which produces events
 * - the server, which relays them (adding duration to post_tool_use)
 * - the Three.js client, which consumes them
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

/**
 * What the hook keeps of a tool's input: short text fields (truncated to 300
 * characters), line counts instead of contents, and the number of todos
 */
export interface ToolInputSummary {
  file_path?: string
  notebook_path?: string
  command?: string
  pattern?: string
  url?: string
  query?: string
  description?: string
  /** Lines of Edit's old_string / new_string */
  old_lines?: number
  new_lines?: number
  /** Lines of Write's content */
  content_lines?: number
  /** Number of TodoWrite todos */
  todo_count?: number
}

export interface PreToolUseEvent extends BaseEvent {
  type: 'pre_tool_use'
  tool: ToolName
  toolInput: ToolInputSummary
  toolUseId: string
}

export interface PostToolUseEvent extends BaseEvent {
  type: 'post_tool_use'
  tool: ToolName
  toolInput: ToolInputSummary
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
}

export interface SubagentStopEvent extends BaseEvent {
  type: 'subagent_stop'
}

export interface SessionStartEvent extends BaseEvent {
  type: 'session_start'
}

export interface SessionEndEvent extends BaseEvent {
  type: 'session_end'
}

// ============================================================================
// User Interaction Events
// ============================================================================

export interface UserPromptSubmitEvent extends BaseEvent {
  type: 'user_prompt_submit'
}

export interface NotificationEvent extends BaseEvent {
  type: 'notification'
  notificationType: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog' | string
}

// ============================================================================
// Other Events
// ============================================================================

export interface PreCompactEvent extends BaseEvent {
  type: 'pre_compact'
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

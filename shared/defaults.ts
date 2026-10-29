/**
 * Vibecraft - Central Configuration Defaults
 *
 * Single source of truth for default values.
 * Environment variables override these defaults.
 */

export const DEFAULTS = {
  /** WebSocket/API server port */
  SERVER_PORT: 4003,

  /**
   * Server bind address. Loopback only by default: the API can drive Claude
   * sessions via tmux, so it must not be reachable from the network.
   */
  SERVER_HOST: '127.0.0.1',

  /** Vite dev server port */
  CLIENT_PORT: 4002,

  /**
   * Events file path.
   * Uses ~/.vibecraft/ to ensure consistent location regardless of
   * how vibecraft was installed (npx, global npm, local dev).
   * The ~ is expanded by the server at runtime.
   */
  EVENTS_FILE: '~/.vibecraft/data/events.jsonl',

  /**
   * Sessions file path.
   * Uses ~/.vibecraft/ for consistency across installations.
   */
  SESSIONS_FILE: '~/.vibecraft/data/sessions.json',

  /** Max events to keep in memory */
  MAX_EVENTS: 1000,

  /** tmux session name */
  TMUX_SESSION: 'claude',

  /**
   * External sessions (Claude Code started outside vibecraft) get a view-only
   * zone while they have events newer than this.
   */
  EXTERNAL_SESSION_MAX_AGE_MS: 30 * 60 * 1000,
} as const

export type Defaults = typeof DEFAULTS

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
   * Server bind address. Loopback only by default: events carry your prompts
   * and commands, so they must not be reachable from the network.
   */
  SERVER_HOST: '127.0.0.1',

  /** Events file written by the hook (~ is expanded by the server) */
  EVENTS_FILE: '~/.vibecraft/data/events.jsonl',

  /** Max events to keep in memory */
  MAX_EVENTS: 1000,

  /** Sessions get a zone while they have events newer than this */
  SESSION_MAX_AGE_MS: 30 * 60 * 1000,
} as const

export type Defaults = typeof DEFAULTS

/**
 * In-memory event log: dedupe, tool durations, size limit and history.
 *
 * No I/O or server state, so it can be unit tested and ported as a unit.
 */

import type { ClaudeEvent, PostToolUseEvent, PreToolUseEvent } from '../shared/types.js'

export class EventStore {
  /** Events in arrival order, at most maxEvents */
  readonly events: ClaudeEvent[] = []

  /** Seen event IDs, so an event delivered by both the file and HTTP counts once */
  private readonly seenIds = new Set<string>()

  /** pre_tool_use timestamps by toolUseId, until the matching post_tool_use */
  private readonly pendingToolUses = new Map<string, number>()

  private readonly maxEvents: number

  constructor(maxEvents: number) {
    this.maxEvents = maxEvents
  }

  /**
   * Add an event. Returns it (post_tool_use gets `duration` from its
   * pre_tool_use), or null if this id was already seen.
   */
  add(event: ClaudeEvent): ClaudeEvent | null {
    if (this.seenIds.has(event.id)) return null
    this.seenIds.add(event.id)

    // Bound the id set: keep the newest maxEvents once it reaches twice that
    if (this.seenIds.size > this.maxEvents * 2) {
      const idsToKeep = [...this.seenIds].slice(-this.maxEvents)
      this.seenIds.clear()
      idsToKeep.forEach(id => this.seenIds.add(id))
    }

    if (event.type === 'pre_tool_use') {
      const pre = event as PreToolUseEvent
      this.pendingToolUses.set(pre.toolUseId, pre.timestamp)
    } else if (event.type === 'post_tool_use') {
      const post = event as PostToolUseEvent
      const start = this.pendingToolUses.get(post.toolUseId)
      if (start !== undefined) {
        post.duration = post.timestamp - start
        this.pendingToolUses.delete(post.toolUseId)
      }
    }

    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    return event
  }

  /** The last `limit` events */
  recent(limit: number): ClaudeEvent[] {
    return this.events.slice(-limit)
  }

  /**
   * History for a newly connected client: events from managed sessions, plus
   * recent events from external sessions (the client gives those view-only zones)
   */
  initialHistory(managedClaudeIds: Set<string>, cutoffTimestamp: number, limit = 50): ClaudeEvent[] {
    return this.events
      .filter(e => managedClaudeIds.has(e.sessionId) || e.timestamp >= cutoffTimestamp)
      .slice(-limit)
  }

  /** Session of the newest event, or 'unknown' */
  lastSessionId(): string {
    return this.events[this.events.length - 1]?.sessionId ?? 'unknown'
  }
}

/**
 * Splits appended bytes into complete lines, holding back a trailing partial
 * line. Works on bytes so a read that cuts a multibyte character in half
 * doesn't corrupt it.
 */
export class LineSplitter {
  private remainder: Buffer = Buffer.alloc(0)

  /** Feed new bytes; returns the complete, non-empty lines they finish */
  push(bytes: Buffer): string[] {
    const data = this.remainder.length ? Buffer.concat([this.remainder, bytes]) : bytes
    const lines: string[] = []
    let start = 0
    for (let nl = data.indexOf(0x0a, start); nl !== -1; nl = data.indexOf(0x0a, start)) {
      if (nl > start) lines.push(data.toString('utf-8', start, nl))
      start = nl + 1
    }
    this.remainder = Buffer.from(data.subarray(start))
    return lines
  }

  reset(): void {
    this.remainder = Buffer.alloc(0)
  }
}

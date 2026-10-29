/**
 * EventClient - WebSocket client for receiving Claude Code events
 * (receive-only: the server pushes events, history and text tiles)
 */

import type { ClaudeEvent, ServerMessage } from '../../shared/types'

export type EventHandler = (event: ClaudeEvent) => void
export type HistoryHandler = (events: ClaudeEvent[]) => void
export type ConnectionHandler = (connected: boolean) => void
export type RawMessageHandler = (data: { type: string; payload?: unknown }) => void

export interface EventClientOptions {
  url: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  debug?: boolean
}

export class EventClient {
  private ws: WebSocket | null = null
  private options: Required<EventClientOptions>
  private eventHandlers: Set<EventHandler> = new Set()
  private historyHandlers: Set<HistoryHandler> = new Set()
  private connectionHandlers: Set<ConnectionHandler> = new Set()
  private rawMessageHandlers: Set<RawMessageHandler> = new Set()
  private reconnectAttempts = 0
  private reconnectTimeout: number | null = null
  private _isConnected = false

  constructor(options: EventClientOptions) {
    this.options = {
      reconnectInterval: 2000,
      maxReconnectAttempts: Infinity,
      debug: false,
      ...options,
    }
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  private log(...args: unknown[]) {
    if (this.options.debug) {
      console.log('[EventClient]', ...args)
    }
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log('Already connected')
      return
    }

    this.log('Connecting to', this.options.url)

    try {
      this.ws = new WebSocket(this.options.url)

      this.ws.onopen = () => {
        this.log('Connected')
        this._isConnected = true
        this.reconnectAttempts = 0
        this.notifyConnectionHandlers(true)
      }

      this.ws.onclose = () => {
        this.log('Disconnected')
        this._isConnected = false
        this.notifyConnectionHandlers(false)
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        this.log('WebSocket error:', error)
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage
          this.handleMessage(message)
        } catch (e) {
          this.log('Failed to parse message:', e)
        }
      }
    } catch (e) {
      this.log('Failed to connect:', e)
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this._isConnected = false
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached')
      return
    }

    this.reconnectAttempts++
    this.log(`Reconnecting in ${this.options.reconnectInterval}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect()
    }, this.options.reconnectInterval)
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'event':
        this.log('Event:', message.payload.type)
        this.notifyEventHandlers(message.payload)
        break

      case 'history':
        this.log(`Received ${message.payload.length} historical events`)
        // If there are history handlers, call them with the batch
        if (this.historyHandlers.size > 0) {
          this.notifyHistoryHandlers(message.payload)
        } else {
          // Fallback: process events individually
          for (const event of message.payload) {
            this.notifyEventHandlers(event)
          }
        }
        break

      case 'connected':
        this.log('Session:', message.payload.sessionId)
        break

      default:
        // Pass unknown message types to raw message handlers
        this.notifyRawMessageHandlers(message as { type: string; payload?: unknown })
        break
    }
  }

  private notifyRawMessageHandlers(data: { type: string; payload?: unknown }): void {
    for (const handler of this.rawMessageHandlers) {
      try {
        handler(data)
      } catch (e) {
        console.error('Raw message handler error:', e)
      }
    }
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onHistory(handler: HistoryHandler): () => void {
    this.historyHandlers.add(handler)
    return () => this.historyHandlers.delete(handler)
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  /** Handle raw messages that aren't standard event types (e.g., text tiles) */
  onRawMessage(handler: RawMessageHandler): () => void {
    this.rawMessageHandlers.add(handler)
    return () => this.rawMessageHandlers.delete(handler)
  }

  private notifyEventHandlers(event: ClaudeEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (e) {
        console.error('Event handler error:', e)
      }
    }
  }

  private notifyHistoryHandlers(events: ClaudeEvent[]): void {
    for (const handler of this.historyHandlers) {
      try {
        handler(events)
      } catch (e) {
        console.error('History handler error:', e)
      }
    }
  }

  private notifyConnectionHandlers(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected)
      } catch (e) {
        console.error('Connection handler error:', e)
      }
    }
  }
}

import { MAX_MESSAGE_SIZE } from './constants.js'
import { PeerCore, type PubSubLike } from './peer-core.js'
import type { NetworkStats } from './peer.js'

type PeerEvent = 'signal' | 'connect' | 'close' | 'data' | 'error'

type WriterLike = {
  write: (chunk: Uint8Array) => Promise<void>
  close?: () => Promise<void>
  releaseLock?: () => void
}

type ReaderLike = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel?: () => Promise<void>
  releaseLock?: () => void
}

type WebTransportLike = {
  ready: Promise<void>
  closed: Promise<void>
  createBidirectionalStream: () => Promise<unknown>
  close?: () => void
}

const getWebTransportCtor = (): new (url: string) => WebTransportLike => {
  const candidate = globalThis as unknown as {
    WebTransport?: new (url: string) => WebTransportLike
  }
  if (!candidate.WebTransport) {
    throw new Error('WebTransport is not available in this runtime')
  }
  return candidate.WebTransport
}

export default class WebTransportPeer {
  #session: WebTransportLike | null = null
  #reader: ReaderLike | null = null
  #writer: WriterLike | null = null
  #listeners: Map<PeerEvent, Set<(...args: unknown[]) => void>> = new Map()
  #destroyed = false
  #connected = false
  #core: PeerCore

  initiator = true
  peerId: string
  channelName: string
  version: string
  compressionThreshold = 0.98
  bw: {
    up: number
    down: number
  } = { up: 0, down: 0 }

  get connected() {
    return this.#connected
  }

  constructor(options: {
    from: string
    to: string
    version: string | number
    url: string
    compressionThreshold?: number
  }) {
    this.peerId = options.to
    this.channelName = `webtransport:${options.from}:${options.to}`
    this.version = String(options.version)
    if (options.compressionThreshold !== undefined) {
      this.compressionThreshold = options.compressionThreshold
    }

    this.#core = new PeerCore(
      {
        kind: 'webtransport-bidi',
        isConnected: () => this.connected,
        sendRaw: (payload) => {
          void this.#sendRaw(payload)
        }
      },
      {
        maxMessageSize: MAX_MESSAGE_SIZE,
        compressionThreshold: this.compressionThreshold,
        getPubSub: this.#getPubSub,
        onPayloadSend: (payloadBytes) => {
          this.bw.up += payloadBytes
        }
      }
    )

    queueMicrotask(() => {
      void this.#open(options.url)
    })
  }

  #createMessageId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto)
    }
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  #getPubSub(): PubSubLike | null {
    const pubsubCandidate = (globalThis as { pubsub?: Partial<PubSubLike> })
      .pubsub
    if (
      pubsubCandidate &&
      typeof pubsubCandidate.subscribe === 'function' &&
      typeof pubsubCandidate.unsubscribe === 'function'
    ) {
      return pubsubCandidate as PubSubLike
    }
    return null
  }

  #emit(event: PeerEvent, ...args: unknown[]) {
    const listeners = this.#listeners.get(event)
    if (!listeners) return
    for (const handler of listeners) handler(...args)
  }

  async #open(url: string) {
    try {
      const WebTransportCtor = getWebTransportCtor()
      const session = new WebTransportCtor(url)
      this.#session = session
      await session.ready
      const stream = (await session.createBidirectionalStream()) as {
        readable: ReadableStream<Uint8Array>
        writable: WritableStream<Uint8Array>
      }
      this.#reader = stream.readable.getReader() as unknown as ReaderLike
      this.#writer = stream.writable.getWriter() as unknown as WriterLike
      this.#connected = true
      this.#emit('connect')
      void this.#readLoop()

      void session.closed.catch((error) => {
        if (this.#destroyed) return
        this.#emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        )
      })
    } catch (error) {
      this.#emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
      this.destroy()
    }
  }

  async #readLoop() {
    const reader = this.#reader
    if (!reader) return

    try {
      while (!this.#destroyed) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        this.bw.down += value.length
        this.#emit('data', value)
      }
    } catch (error) {
      if (!this.#destroyed) {
        this.#emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }

    if (!this.#destroyed) this.destroy()
  }

  async #sendRaw(payload: Uint8Array) {
    if (!this.#writer) throw new Error('WebTransport writer is not ready')
    await this.#writer.write(payload)
  }

  on(event: PeerEvent, handler: (...args: unknown[]) => void) {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(handler)
    this.#listeners.set(event, listeners)
    return this
  }

  off(event: PeerEvent, handler: (...args: unknown[]) => void) {
    this.#listeners.get(event)?.delete(handler)
    return this
  }

  signal(_signalData: unknown) {
    // WebTransport does not use SDP/ICE signaling in this peer implementation.
  }

  send(data: Uint8Array, id = this.#createMessageId()) {
    this.#core.send(data, id)
  }

  request(data: Uint8Array, id = this.#createMessageId()): Promise<Uint8Array> {
    return this.#core.request(data, id)
  }

  async getNetworkStats(): Promise<NetworkStats | null> {
    return null
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#connected = false

    try {
      void this.#reader?.cancel?.()
    } catch (e) {}
    this.#reader?.releaseLock?.()
    this.#reader = null

    try {
      void this.#writer?.close?.()
    } catch (e) {}
    this.#writer?.releaseLock?.()
    this.#writer = null

    try {
      this.#session?.close?.()
    } catch (e) {}
    this.#session = null

    this.#emit('close')
  }
}

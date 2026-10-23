import { MAX_MESSAGE_SIZE } from './constants.js'
import { PeerCore, type PubSubLike } from './peer-core.js'
import type { NetworkStats } from './peer.js'
import { FrameReader, encodeFrame, jsonBytes, parseJson } from '../transport-frames.js'

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

const getWebTransportCtor = async (): Promise<new (url: string) => WebTransportLike> => {
  const candidate = globalThis as unknown as {
    WebTransport?: new (url: string) => WebTransportLike
    process?: { versions?: { node?: string } }
  }
  if (!candidate.WebTransport && candidate.process?.versions?.node) {
    const { WebTransport } = await import('@fails-components/webtransport')
    return WebTransport as unknown as new (url: string) => WebTransportLike
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
    getTicket: () => Promise<string>
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
          void this.#sendRaw(payload).catch(error => {
            if (!this.#destroyed) { this.#emit('error', error); this.destroy() }
          })
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
      void this.#open(options)
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

  async #open(options: { url: string; getTicket: () => Promise<string> }) {
    try {
      const ticket = await options.getTicket()
      if (this.#destroyed) return
      const WebTransportCtor = await getWebTransportCtor()
      const session = new WebTransportCtor(options.url)
      this.#session = session
      void session.closed.then(() => this.destroy(), error => {
        if (!this.#destroyed) { this.#emit('error', error); this.destroy() }
      })
      await session.ready
      if (this.#destroyed) return
      const stream = (await session.createBidirectionalStream()) as {
        readable: ReadableStream<Uint8Array>
        writable: WritableStream<Uint8Array>
      }
      if (this.#destroyed) return
      this.#reader = stream.readable.getReader() as unknown as ReaderLike
      this.#writer = stream.writable.getWriter() as unknown as WriterLike
      const frames = new FrameReader(this.#reader)
      await this.#writer.write(encodeFrame(jsonBytes({ protocol: 'swarm-relay/1', ticket })))
      const ready = parseJson(await frames.read())
      if (ready.protocol !== 'swarm-relay/1' || ready.peerId !== this.peerId || String(ready.version) !== this.version) {
        throw new Error('invalid WebTransport relay handshake')
      }
      if (this.#destroyed) return
      this.#connected = true
      this.#emit('connect')
      void this.#readLoop(frames)
    } catch (error) {
      this.#emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
      this.destroy()
    }
  }

  async #readLoop(frames: FrameReader) {
    const reader = this.#reader
    if (!reader) return

    try {
      while (!this.#destroyed) {
        // eslint-disable-next-line no-await-in-loop
        const value = await frames.read()
        if (!value) break
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
    await this.#writer.write(encodeFrame(payload))
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
      void this.#reader?.cancel?.().catch(() => {})
    } catch (e) {}
    this.#reader?.releaseLock?.()
    this.#reader = null

    try {
      void this.#writer?.close?.().catch(() => {})
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

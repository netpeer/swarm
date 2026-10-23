import { PeerCore } from './peer-core.js'
type PeerEvent = 'signal' | 'connect' | 'close' | 'data' | 'error'

type PubSubLike = {
  subscribe: (
    topic: string,
    handler: (message: { data: Uint8Array }) => void
  ) => void
  unsubscribe: (
    topic: string,
    handler: (message: { data: Uint8Array }) => void
  ) => void
}

const getPubSub = (): PubSubLike | null => {
  const candidate = (globalThis as { pubsub?: Partial<PubSubLike> }).pubsub
  if (
    candidate &&
    typeof candidate.subscribe === 'function' &&
    typeof candidate.unsubscribe === 'function'
  ) {
    return candidate as PubSubLike
  }
  return null
}

export default class CircuitPeer {
  #listeners: Map<PeerEvent, Set<(...args: unknown[]) => void>> = new Map()
  #destroyed = false
  #connected = false
  #sendViaCircuit: (payload: { id: string; data: number[] }) => Promise<unknown>
  #core: PeerCore

  initiator = true
  peerId: string
  channelName: string
  version: string
  bw: { up: number; down: number } = { up: 0, down: 0 }

  get connected() {
    return this.#connected
  }

  constructor(options: {
    from: string
    to: string
    version: string | number
    handshake: () => Promise<void>
    sendViaCircuit: (payload: {
      id: string
      data: number[]
    }) => Promise<unknown>
  }) {
    this.peerId = options.to
    this.channelName = `circuit:${options.from}:${options.to}`
    this.version = String(options.version)
    this.#sendViaCircuit = options.sendViaCircuit
    this.#core = new PeerCore({
      kind: 'circuit',
      isConnected: () => this.connected,
      sendRaw: data => {
        void this.#sendViaCircuit({ id: this.#createMessageId(), data: Array.from(data) }).catch(error => {
          if (this.#destroyed) return
          this.#emit('error', error)
          this.destroy()
        })
      }
    }, {
      // JSON byte arrays expand up to four characters per byte. Keep the whole
      // WebSocket frame below its default 64 KiB limit, including wrapper/ID.
      maxMessageSize: 14_000,
      compressionThreshold: 0.98,
      getPubSub,
      onPayloadSend: bytes => { this.bw.up += bytes }
    })

    queueMicrotask(async () => {
      try {
        await options.handshake()
        if (this.#destroyed) return
        this.#connected = true
        this.#emit('connect')
      } catch (error) {
        if (this.#destroyed) return
        this.#emit('error', error)
        this.destroy()
      }
    })
  }

  #createMessageId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto)
    }
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  #emit(event: PeerEvent, ...args: unknown[]) {
    const listeners = this.#listeners.get(event)
    if (!listeners) return
    for (const handler of listeners) handler(...args)
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
    // Circuit transport does not use SDP/ICE signaling.
  }

  send(data: Uint8Array, id = this.#createMessageId()) {
    if (new TextEncoder().encode(id).length > 1024) {
      this.#emit('error', new Error('circuit message id exceeds 1024 bytes'))
      return
    }
    if (this.#destroyed) {
      this.#emit('error', new Error('circuit peer is destroyed'))
      return
    }

    this.#core.send(data, id)
  }

  request(data: Uint8Array, id = this.#createMessageId()): Promise<Uint8Array> {
    if (new TextEncoder().encode(id).length > 1024) {
      return Promise.reject(new Error('circuit message id exceeds 1024 bytes'))
    }
    return this.#core.request(data, id)
  }

  async getNetworkStats(): Promise<null> {
    return null
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#connected = false
    this.#emit('close')
  }
}

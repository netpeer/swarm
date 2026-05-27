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
    sendViaCircuit: (payload: {
      id: string
      data: number[]
    }) => Promise<unknown>
  }) {
    this.peerId = options.to
    this.channelName = `circuit:${options.from}:${options.to}`
    this.version = String(options.version)
    this.#sendViaCircuit = options.sendViaCircuit

    setTimeout(() => {
      if (this.#destroyed) return
      this.#connected = true
      this.#emit('connect')
    }, 0)
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
    if (this.#destroyed) {
      this.#emit('error', new Error('circuit peer is destroyed'))
      return
    }

    this.bw.up += data.length
    void this.#sendViaCircuit({ id, data: Array.from(data) }).catch((error) => {
      this.#emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
    })
  }

  request(data: Uint8Array, id = this.#createMessageId()): Promise<Uint8Array> {
    const pubsub = getPubSub()
    if (!pubsub) {
      return Promise.reject(new Error('globalThis.pubsub is not available'))
    }

    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        try {
          pubsub.unsubscribe(id, onResponse)
        } catch (e) {}
        fn()
      }

      const onResponse = ({ data: response }: { data: Uint8Array }) => {
        finish(() => resolve(response))
      }

      timeout = setTimeout(() => {
        finish(() => reject(new Error(`request for ${id} timed out`)))
      }, 30_000)

      pubsub.subscribe(id, onResponse)
      this.send(data, id)
    })
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

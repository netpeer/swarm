import { SocketRequestClient } from 'socket-request-client'
import WebRTCPeer from './webrtc-peer.js'
import WebTransportPeer from './webtransport-peer.js'
import CircuitPeer from './circuit-peer.js'
import '@vandeurenglenn/debug'
import { MAX_MESSAGE_SIZE, defaultOptions } from './constants.js'
import { Options } from '../types.js'
import { createDebugger } from '@vandeurenglenn/debug'
import { inflate } from 'pako'

// Simple CRC32 implementation
const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

const debug = createDebugger('@netpeer/swarm/client')

type WrtcImplementation = {
  RTCPeerConnection: new (...args: unknown[]) => unknown
  RTCSessionDescription: new (...args: unknown[]) => unknown
  RTCIceCandidate: new (...args: unknown[]) => unknown
}

type WrtcBackendName = 'koush'

const isWrtcImplementation = (
  candidate: unknown
): candidate is WrtcImplementation => {
  if (!candidate || typeof candidate !== 'object') return false
  const wrtcCandidate = candidate as Partial<WrtcImplementation>
  return (
    typeof wrtcCandidate.RTCPeerConnection === 'function' &&
    typeof wrtcCandidate.RTCSessionDescription === 'function' &&
    typeof wrtcCandidate.RTCIceCandidate === 'function'
  )
}

type WrtcLoadResult = {
  backend: WrtcBackendName
  implementation: WrtcImplementation
}

type ClientTransportKind = 'webrtc' | 'webtransport'
type ConnectionTransportKind = ClientTransportKind | 'circuit'

type PeerTransportAttempt = {
  order: ConnectionTransportKind[]
  index: number
  star: string
  version: string
  initiator: boolean
  timeout?: ReturnType<typeof setTimeout>
}

type CircuitFallbackPayload = {
  id?: string
  data?: number[]
}

type TransportMeta = {
  kind?: ClientTransportKind
  kinds?: ClientTransportKind[]
}

type PeerConnectionLike = {
  connected: boolean
  initiator: boolean
  peerId: string
  channelName: string
  on: (event: string, handler: (...args: unknown[]) => void) => unknown
  off: (event: string, handler: (...args: unknown[]) => void) => unknown
  signal: (signalData: unknown) => void
  destroy: () => void
  send: (data: Uint8Array, id?: string) => void
  request: (data: Uint8Array, id?: string) => Promise<Uint8Array>
}

type CircuitRequestPayload = {
  to: string
  from: string
  id: string
  phase: 'request' | 'response'
  method?: string
  data?: unknown
  error?: string
}

type CircuitHandler = (
  payload: unknown,
  context: { from: string; method: string; id: string }
) => Promise<unknown> | unknown

type TransportAttemptEvent = {
  type:
    | 'attempt-started'
    | 'attempt-advanced'
    | 'attempt-timeout'
    | 'attempt-error'
    | 'connected'
    | 'attempts-exhausted'
  peerId: string
  transport: ConnectionTransportKind
  attemptIndex: number
  order: ConnectionTransportKind[]
  reason?: string
}

type ClientTestHooks = {
  skipInit?: boolean
  allowConnectWithoutStar?: boolean
  createPeer?: (args: {
    kind: ConnectionTransportKind
    peerId: string
    version: string
    initiator: boolean
    star?: string
    url?: string
  }) => PeerConnectionLike | null
  onTransportEvent?: (event: TransportAttemptEvent) => void
}

export default class Client {
  #peerId
  #connections: { [index: string]: PeerConnectionLike } = {}
  #stars: { [index: string]: SocketRequestClient['clientConnection'] } = {}
  #starListeners: {
    [index: string]: { topic: string; handler: (...args: any[]) => void }[]
  } = {}
  #reinitLock: Promise<void> | null = null
  #connectEvent = 'peer:connected'
  #supportedTransports: Set<ClientTransportKind> = new Set(['webrtc'])
  #preferredTransportKind: ClientTransportKind = 'webrtc'
  #fallbackTransportOrder: ConnectionTransportKind[] = []
  #enableCircuitFallback = true
  #transportConnectTimeoutMs = 10_000
  #peerTransportAttempts: Map<string, PeerTransportAttempt> = new Map()
  #peerTransportKinds: Map<string, ConnectionTransportKind> = new Map()
  #fallbackCircuitMethod = 'swarm:fallback:send'
  #testHooks?: ClientTestHooks
  #webTransportUrlTemplate?: string
  #circuitHandlers: Map<string, CircuitHandler> = new Map()
  #pendingCircuitRequests: Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  > = new Map()
  #circuitRequestTimeoutMs = 30_000
  #retryOptions = { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 30000 }
  id: string
  networkVersion: string
  starsConfig: string[]
  socketClient: SocketRequestClient
  messageSize = 262144
  version: string

  #messagesToHandle: {
    [id: string]:
      | any[]
      | {
          chunks: Uint8Array[]
          receivedBytes: number
          expectedSize: number
          expectedCount: number
        }
  } = {}

  get peerId() {
    return this.#peerId
  }

  get connections() {
    return { ...this.#connections }
  }

  get peers() {
    return Object.entries(this.#connections)
  }

  getPeer(peerId) {
    return this.#connections[peerId]
  }

  constructor(options: Options) {
    const { peerId, networkVersion, version, connectEvent, stars } = {
      ...defaultOptions,
      ...options
    }
    this.#peerId = peerId
    this.networkVersion = networkVersion
    this.version = version
    this.#testHooks = options.testHooks
    this.#connectEvent = connectEvent
    this.starsConfig = stars

    const configuredKinds = options.transport?.kinds
      ? options.transport.kinds
      : options.transport?.kind
        ? [options.transport.kind]
        : (['webrtc', 'webtransport'] as ClientTransportKind[])

    this.#supportedTransports = new Set(
      this.#normalizeTransportKinds(configuredKinds)
    )
    if (!this.#supportedTransports.size) this.#supportedTransports.add('webrtc')

    const configuredPreferred =
      options.transport?.preferredKind || options.transport?.kind || 'webrtc'
    this.#preferredTransportKind = this.#supportedTransports.has(
      configuredPreferred
    )
      ? configuredPreferred
      : this.#supportedTransports.has('webrtc')
        ? 'webrtc'
        : 'webtransport'

    this.#webTransportUrlTemplate = options.transport?.webtransport?.urlTemplate
    this.#enableCircuitFallback = options.transport?.fallback?.enabled ?? true
    if (
      typeof options.transport?.fallback?.connectTimeoutMs === 'number' &&
      options.transport.fallback.connectTimeoutMs > 0
    ) {
      this.#transportConnectTimeoutMs =
        options.transport.fallback.connectTimeoutMs
    }
    this.#fallbackTransportOrder = this.#normalizeFallbackOrder(
      options.transport?.fallback?.order
    )
    if (options?.retry)
      this.#retryOptions = { ...this.#retryOptions, ...options.retry }

    this.#circuitHandlers.set(this.#fallbackCircuitMethod, (payload, context) =>
      this.#handleFallbackCircuitPayload(payload, context)
    )

    if (!this.#testHooks?.skipInit) {
      this._init()
    }
  }

  /**
   * Safely reinitialize the client (used after system resume/sleep).
   * It closes existing connections and reconnects to configured stars.
   */
  async reinit() {
    // avoid concurrent reinit runs
    if (this.#reinitLock) return this.#reinitLock
    this.#reinitLock = (async () => {
      debug('reinit: start')
      try {
        await this.close()
        this.#stars = {}
        this.#connections = {}

        for (const star of this.starsConfig) {
          try {
            await this.setupStar(star)
          } catch (e) {
            // If last star fails and none connected, surface error
            if (Object.keys(this.#stars).length === 0)
              throw new Error(`No star available to connect`)
          }
        }
      } finally {
        debug('reinit: done')
        this.#reinitLock = null
      }
    })()

    return this.#reinitLock
  }

  async setupStar(star) {
    const { retries, factor, minTimeout, maxTimeout } = this.#retryOptions

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    let attempt = 0
    let lastErr
    while (attempt <= retries) {
      try {
        const client = new SocketRequestClient(star, this.networkVersion)
        this.#stars[star] = await client.init()
        this.setupStarListeners(this.#stars[star], star)
        this.#stars[star].send({
          url: 'join',
          params: {
            version: this.version,
            peerId: this.peerId,
            transport: {
              kind: this.#preferredTransportKind,
              kinds: [...this.#supportedTransports]
            }
          }
        })
        globalThis.pubsub.publishVerbose('star:connected', star)
        debug(`setupStar ${star} succeeded`)
        return this.#stars[star]
      } catch (e) {
        lastErr = e
        attempt += 1
        if (attempt > retries) break
        const delay = Math.min(
          maxTimeout,
          Math.round(minTimeout * Math.pow(factor, attempt - 1))
        )
        debug(
          `setupStar ${star} failed, retrying in ${delay}ms (attempt ${attempt})`
        )
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay)
      }
    }

    throw lastErr
  }

  async _init() {
    if (
      !globalThis.RTCPeerConnection &&
      !(globalThis as { wrtc?: unknown }).wrtc
    ) {
      const { backend, implementation } =
        await this.#loadNodeWebrtcImplementation()
      ;(
        globalThis as {
          wrtc?: WrtcImplementation
          __swarmWrtcImpl?: WrtcBackendName
        }
      ).wrtc = implementation
      ;(
        globalThis as {
          wrtc?: WrtcImplementation
          __swarmWrtcImpl?: WrtcBackendName
        }
      ).__swarmWrtcImpl = backend
    }

    for (const star of this.starsConfig) {
      try {
        await this.setupStar(star)
      } catch (e) {
        if (
          this.starsConfig.indexOf(star) === this.starsConfig.length - 1 &&
          !this.socketClient
        )
          throw new Error(`No star available to connect`)
      }
    }
    if (globalThis.process?.versions?.node) {
      process.on('SIGINT', async () => {
        process.stdin.resume()
        await this.close()
        process.exit()
      })
    } else {
      globalThis.addEventListener('beforeunload', this.close.bind(this))
    }
  }

  async #loadNodeWebrtcImplementation(): Promise<WrtcLoadResult> {
    const koushWrtcModule = await import('@koush/wrtc')
    const koushWrtc = koushWrtcModule.default
    if (!isWrtcImplementation(koushWrtc)) {
      throw new Error('@koush/wrtc does not match required wrtc contract')
    }

    debug('using @koush/wrtc as wrtc implementation')
    return { backend: 'koush', implementation: koushWrtc }
  }

  setupStarListeners(starConnection, starId) {
    // create stable references to handlers so we can unsubscribe later
    const onPeerJoined = (id) => this.#peerJoined(id, starConnection)
    const onPeerLeft = (id) => this.#peerLeft(id, starConnection)
    const onStarJoined = this.#starJoined
    const onStarLeft = this.#starLeft
    const onSignal = (message) => this.#inComingSignal(message, starConnection)
    const onCircuit = (message) =>
      this.#inComingCircuit(message, starConnection)
    const onServerData = (message) => {
      globalThis.pubsub.publish('server:data', message)
    }

    starConnection.pubsub.subscribe('peer:joined', onPeerJoined)
    starConnection.pubsub.subscribe('peer:left', onPeerLeft)
    starConnection.pubsub.subscribe('star:joined', onStarJoined)
    starConnection.pubsub.subscribe('star:left', onStarLeft)
    starConnection.pubsub.subscribe('signal', onSignal)
    starConnection.pubsub.subscribe('circuit', onCircuit)
    starConnection.pubsub.subscribe('server:data', onServerData)

    this.#starListeners[starId] = [
      { topic: 'peer:joined', handler: onPeerJoined },
      { topic: 'peer:left', handler: onPeerLeft },
      { topic: 'star:joined', handler: onStarJoined },
      { topic: 'star:left', handler: onStarLeft },
      { topic: 'signal', handler: onSignal },
      { topic: 'circuit', handler: onCircuit },
      { topic: 'server:data', handler: onServerData }
    ]
  }

  #starJoined = (id) => {
    if (this.#stars[id]) {
      this.#stars[id].close(0)
      delete this.#stars[id]
    }
    console.log(`star ${id} joined`)
  }

  #starLeft = async (id) => {
    if (this.#stars[id]) {
      this.#stars[id].close(0)
      delete this.#stars[id]
    }

    // if we lost all stars, try to reconnect to configured stars with backoff
    if (Object.keys(this.#stars).length === 0) {
      for (const star of this.starsConfig) {
        try {
          await this.setupStar(star)
          // stop at first success
          return
        } catch (e) {
          debug(`reconnect star ${star} failed: ${e.message || e}`)
          if (this.starsConfig.indexOf(star) === this.starsConfig.length - 1)
            throw new Error(`No star available to connect`)
        }
      }
    }
    debug(`star ${id} left`)
  }

  #peerLeft = (peer, star) => {
    const id = peer.peerId || peer

    if (this.#connections[id]) {
      this.#connections[id].destroy()
      delete this.#connections[id]
    }
    debug(`peer ${id} left`)
  }

  #normalizeTransportKinds(kinds: unknown): ClientTransportKind[] {
    if (!Array.isArray(kinds)) return []
    const normalized = new Set<ClientTransportKind>()
    for (const kind of kinds) {
      if (kind === 'webrtc' || kind === 'webtransport') normalized.add(kind)
    }
    return [...normalized]
  }

  #normalizeFallbackOrder(kinds: unknown): ConnectionTransportKind[] {
    if (!Array.isArray(kinds)) return []
    const normalized = new Set<ConnectionTransportKind>()
    for (const kind of kinds) {
      if (kind === 'webrtc' || kind === 'webtransport' || kind === 'circuit') {
        normalized.add(kind)
      }
    }
    return [...normalized]
  }

  #supportsTransport(kind: ClientTransportKind): boolean {
    return this.#supportedTransports.has(kind)
  }

  #getRemoteTransportKinds(
    transport: TransportMeta | undefined
  ): ClientTransportKind[] {
    const fromKinds = this.#normalizeTransportKinds(transport?.kinds)
    if (fromKinds.length) return fromKinds
    if (transport?.kind === 'webrtc' || transport?.kind === 'webtransport') {
      return [transport.kind]
    }
    return ['webrtc']
  }

  #selectTransportForPeer(
    peerId: string,
    transport?: TransportMeta
  ): ClientTransportKind | null {
    const remoteKinds = this.#getRemoteTransportKinds(transport)
    const commonKinds = remoteKinds.filter((kind) =>
      this.#supportsTransport(kind)
    )
    if (!commonKinds.length) {
      debug(
        `peer ${peerId} has no compatible transport with local capabilities`
      )
      return null
    }

    if (transport?.kind && commonKinds.includes(transport.kind)) {
      return transport.kind
    }
    if (commonKinds.includes(this.#preferredTransportKind)) {
      return this.#preferredTransportKind
    }
    if (commonKinds.includes('webrtc')) return 'webrtc'
    return 'webtransport'
  }

  #buildTransportOrder(
    peerId: string,
    transport?: TransportMeta
  ): ConnectionTransportKind[] {
    const remoteKinds = this.#getRemoteTransportKinds(transport)
    const commonKinds = remoteKinds.filter((kind) =>
      this.#supportsTransport(kind)
    )

    if (!commonKinds.length) {
      if (this.#enableCircuitFallback) {
        debug(`peer ${peerId} has no direct transport overlap, using circuit`)
        return ['circuit']
      }
      return []
    }

    const order: ConnectionTransportKind[] = []
    if (transport?.kind && commonKinds.includes(transport.kind)) {
      order.push(transport.kind)
    }
    if (
      commonKinds.includes(this.#preferredTransportKind) &&
      !order.includes(this.#preferredTransportKind)
    ) {
      order.push(this.#preferredTransportKind)
    }

    for (const kind of this.#fallbackTransportOrder) {
      if (
        kind !== 'circuit' &&
        commonKinds.includes(kind) &&
        !order.includes(kind)
      ) {
        order.push(kind)
      }
    }

    if (commonKinds.includes('webrtc') && !order.includes('webrtc')) {
      order.push('webrtc')
    }
    if (
      commonKinds.includes('webtransport') &&
      !order.includes('webtransport')
    ) {
      order.push('webtransport')
    }
    if (this.#enableCircuitFallback && !order.includes('circuit')) {
      order.push('circuit')
    }

    debug(`peer ${peerId} transport order: ${order.join(' -> ')}`)
    return order
  }

  #clearTransportAttempt(peerId: string) {
    const attempt = this.#peerTransportAttempts.get(peerId)
    if (attempt?.timeout) clearTimeout(attempt.timeout)
    this.#peerTransportAttempts.delete(peerId)
  }

  #emitTransportEvent(event: TransportAttemptEvent) {
    this.#testHooks?.onTransportEvent?.(event)
  }

  #advanceTransportAttempt(peerId: string) {
    const attempt = this.#peerTransportAttempts.get(peerId)
    if (!attempt) return
    const previousIndex = attempt.index
    const previousTransport = attempt.order[previousIndex]
    if (attempt.timeout) clearTimeout(attempt.timeout)
    this.#emitTransportEvent({
      type: 'attempt-advanced',
      peerId,
      transport: previousTransport,
      attemptIndex: previousIndex,
      order: [...attempt.order]
    })
    attempt.index += 1
    this.#attemptPeerTransport(peerId)
  }

  #startPeerTransportAttempt(
    peerId: string,
    star: string,
    version: string,
    initiator: boolean,
    transport?: TransportMeta
  ) {
    if (this.#connections[peerId]) return
    if (this.#peerTransportAttempts.has(peerId)) return

    const order = this.#buildTransportOrder(peerId, transport)
    if (!order.length) {
      debug(`peer ${peerId} has no available transport to attempt`)
      return
    }

    this.#peerTransportAttempts.set(peerId, {
      order,
      index: 0,
      star,
      version,
      initiator
    })

    this.#attemptPeerTransport(peerId)
  }

  #attemptPeerTransport(peerId: string) {
    const attempt = this.#peerTransportAttempts.get(peerId)
    if (!attempt) return
    if (attempt.index >= attempt.order.length) {
      const exhaustedTransport =
        attempt.order[attempt.order.length - 1] ?? 'circuit'
      this.#emitTransportEvent({
        type: 'attempts-exhausted',
        peerId,
        transport: exhaustedTransport,
        attemptIndex: attempt.index,
        order: [...attempt.order]
      })
      debug(`peer ${peerId} transport attempts exhausted`)
      this.#clearTransportAttempt(peerId)
      return
    }

    if (this.#connections[peerId]) return

    const transportKind = attempt.order[attempt.index]
    this.#emitTransportEvent({
      type: 'attempt-started',
      peerId,
      transport: transportKind,
      attemptIndex: attempt.index,
      order: [...attempt.order]
    })
    let peer: PeerConnectionLike | null = null

    if (transportKind === 'webrtc') {
      peer = this.#createRTCPeerConnection(
        peerId,
        attempt.star,
        attempt.version,
        attempt.initiator
      )
    } else if (transportKind === 'webtransport') {
      const url = this.#resolveWebTransportUrl(peerId)
      if (!url) {
        this.#advanceTransportAttempt(peerId)
        return
      }
      peer = this.#createWebTransportConnection(peerId, url, attempt.version)
    } else {
      peer = this.#createCircuitConnection(peerId, attempt.version)
    }

    if (!peer) {
      this.#advanceTransportAttempt(peerId)
      return
    }

    attempt.timeout = setTimeout(() => {
      const current = this.#connections[peerId]
      if (!current || current.connected) return
      this.#emitTransportEvent({
        type: 'attempt-timeout',
        peerId,
        transport: transportKind,
        attemptIndex: attempt.index,
        order: [...attempt.order]
      })
      debug(`peer ${peerId} ${transportKind} connect timeout`)
      current.destroy()
    }, this.#transportConnectTimeoutMs)
  }

  #decodeCircuitFallbackPayload(payload: unknown): {
    id: string
    data: Uint8Array
  } | null {
    if (!payload || typeof payload !== 'object') return null
    const candidate = payload as CircuitFallbackPayload
    if (!Array.isArray(candidate.data)) return null
    const id =
      typeof candidate.id === 'string' && candidate.id.length
        ? candidate.id
        : this.#createCircuitId()
    return {
      id,
      data: new Uint8Array(candidate.data.map((byte) => Number(byte) & 255))
    }
  }

  async #handleFallbackCircuitPayload(
    payload: unknown,
    context: { from: string; method: string; id: string }
  ) {
    const decoded = this.#decodeCircuitFallbackPayload(payload)
    if (!decoded) {
      throw new Error('invalid circuit fallback payload')
    }

    let peer = this.#connections[context.from]
    if (!peer) {
      peer = this.#createCircuitConnection(context.from, this.version)
    }
    this.#noticeMessage(decoded.data, decoded.id, context.from, peer)
    return { ok: true }
  }

  #createCircuitId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto)
    }
    return `circuit-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  #encodeCircuitData(data: unknown): unknown {
    if (data instanceof Uint8Array) {
      return { __swarmType: 'u8', data: Array.from(data) }
    }
    return data
  }

  #decodeCircuitData(data: unknown): unknown {
    if (
      data &&
      typeof data === 'object' &&
      (data as { __swarmType?: string }).__swarmType === 'u8' &&
      Array.isArray((data as { data?: unknown[] }).data)
    ) {
      return new Uint8Array(
        (data as { data: unknown[] }).data.map((item) => Number(item) & 255)
      )
    }
    return data
  }

  #pickStarConnection() {
    const entries = Object.values(this.#stars)
    return entries.find((client) => client?.connectionState?.() === 'open')
  }

  #sendCircuit(starConnection, payload: CircuitRequestPayload) {
    starConnection.send({
      url: 'circuit',
      params: payload
    })
  }

  onCircuit(method: string, handler: CircuitHandler) {
    this.#circuitHandlers.set(method, handler)
  }

  offCircuit(method: string) {
    this.#circuitHandlers.delete(method)
  }

  onServerData(handler: (data: unknown) => void) {
    globalThis.pubsub.subscribe('server:data', handler)
  }

  offServerData(handler: (data: unknown) => void) {
    globalThis.pubsub.unsubscribe('server:data', handler)
  }

  circuitRequest(
    peerId: string,
    method: string,
    data?: unknown,
    timeoutMs = this.#circuitRequestTimeoutMs
  ): Promise<unknown> {
    const starConnection = this.#pickStarConnection()
    if (!starConnection) {
      return Promise.reject(
        new Error('no connected star available for circuit request')
      )
    }

    const id = this.#createCircuitId()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingCircuitRequests.delete(id)
        reject(new Error(`circuit request for ${id} timed out`))
      }, timeoutMs)

      this.#pendingCircuitRequests.set(id, { resolve, reject, timeout })

      this.#sendCircuit(starConnection, {
        to: peerId,
        from: this.peerId,
        id,
        phase: 'request',
        method,
        data: this.#encodeCircuitData(data)
      })
    })
  }

  #inComingCircuit = async (
    { from, to, id, phase, method, data, error },
    starConnection
  ) => {
    if (to !== this.peerId) return

    if (phase === 'response') {
      const pending = this.#pendingCircuitRequests.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.#pendingCircuitRequests.delete(id)

      if (error) {
        pending.reject(new Error(String(error)))
        return
      }
      pending.resolve(this.#decodeCircuitData(data))
      return
    }

    if (phase !== 'request') return
    if (typeof method !== 'string' || !method.length) return

    const handler = this.#circuitHandlers.get(method)
    if (!handler) {
      this.#sendCircuit(starConnection, {
        to: from,
        from: this.peerId,
        id,
        phase: 'response',
        error: `no circuit handler registered for method ${method}`
      })
      return
    }

    try {
      const response = await handler(this.#decodeCircuitData(data), {
        from,
        method,
        id
      })

      this.#sendCircuit(starConnection, {
        to: from,
        from: this.peerId,
        id,
        phase: 'response',
        data: this.#encodeCircuitData(response)
      })
    } catch (handlerError) {
      this.#sendCircuit(starConnection, {
        to: from,
        from: this.peerId,
        id,
        phase: 'response',
        error:
          handlerError instanceof Error
            ? handlerError.message
            : String(handlerError)
      })
    }
  }

  connect(peerId, star, initiator = true) {
    if (this.#connections[peerId]) {
      debug(`peer ${peerId} already connected`)
      return
    }
    if (
      !this.#testHooks?.allowConnectWithoutStar &&
      this.#stars[star]?.connectionState() !== 'open'
    ) {
      console.warn(
        `Star ${star} is not connected, cannot reconnect to peer ${peerId}`
      )
      return
    }

    this.#startPeerTransportAttempt(peerId, star, this.version, initiator, {
      kind: this.#preferredTransportKind,
      kinds: [...this.#supportedTransports]
    })
  }

  reconnect(peerId, star, initiator = false) {
    delete this.#connections[peerId]
    debug(`reconnecting to peer ${peerId}`)
    return this.connect(peerId, star, initiator)
  }

  connectWebTransport(peerId: string, url: string) {
    this.#createWebTransportConnection(peerId, url, this.version)
  }

  #resolveWebTransportUrl(peerId: string): string | null {
    const urlTemplate = this.#webTransportUrlTemplate
    if (!urlTemplate) {
      console.warn(
        'WebTransport requires transport.webtransport.urlTemplate in client options'
      )
      return null
    }
    return urlTemplate
      .replace('{peerId}', encodeURIComponent(peerId))
      .replace('{selfId}', encodeURIComponent(this.peerId))
  }

  #createWebTransportConnection(peerId: string, url: string, version: string) {
    if (this.#connections[peerId]) {
      debug(`peer ${peerId} already connected`)
      return null
    }

    const testPeer = this.#testHooks?.createPeer?.({
      kind: 'webtransport',
      peerId,
      version,
      initiator: true,
      url
    })
    if (testPeer) {
      testPeer.on('connect', () => this.#peerConnect(testPeer))
      testPeer.on('close', () => this.#peerClose(testPeer))
      testPeer.on('data', (data) => this.#peerData(testPeer, data))
      testPeer.on('error', (error) => this.#peerError(testPeer, error))
      this.#connections[peerId] = testPeer
      this.#peerTransportKinds.set(peerId, 'webtransport')
      return testPeer
    }

    const peer = new WebTransportPeer({
      from: this.peerId,
      to: peerId,
      version,
      url
    })

    peer.on('connect', () => this.#peerConnect(peer))
    peer.on('close', () => this.#peerClose(peer))
    peer.on('data', (data) => this.#peerData(peer, data))
    peer.on('error', (error) => this.#peerError(peer, error))

    this.#connections[peerId] = peer
    this.#peerTransportKinds.set(peerId, 'webtransport')
    return peer
  }

  #createCircuitConnection(peerId: string, version: string) {
    if (this.#connections[peerId]) {
      debug(`peer ${peerId} already connected`)
      return null
    }

    const testPeer = this.#testHooks?.createPeer?.({
      kind: 'circuit',
      peerId,
      version,
      initiator: true
    })
    if (testPeer) {
      testPeer.on('connect', () => this.#peerConnect(testPeer))
      testPeer.on('close', () => this.#peerClose(testPeer))
      testPeer.on('data', (data) => this.#peerData(testPeer, data))
      testPeer.on('error', (error) => this.#peerError(testPeer, error))
      this.#connections[peerId] = testPeer
      this.#peerTransportKinds.set(peerId, 'circuit')
      return testPeer
    }

    const peer = new CircuitPeer({
      from: this.peerId,
      to: peerId,
      version,
      sendViaCircuit: (payload) =>
        this.circuitRequest(peerId, this.#fallbackCircuitMethod, payload)
    })

    peer.on('connect', () => this.#peerConnect(peer))
    peer.on('close', () => this.#peerClose(peer))
    peer.on('error', (error) => this.#peerError(peer, error))

    this.#connections[peerId] = peer
    this.#peerTransportKinds.set(peerId, 'circuit')
    return peer
  }

  #createRTCPeerConnection = (peerId, star, version, initiator = false) => {
    const testPeer = this.#testHooks?.createPeer?.({
      kind: 'webrtc',
      peerId,
      version,
      initiator,
      star
    })
    if (testPeer) {
      testPeer.on('connect', () => this.#peerConnect(testPeer))
      testPeer.on('close', () => this.#peerClose(testPeer))
      testPeer.on('data', (data) => this.#peerData(testPeer, data))
      testPeer.on('error', (error) => this.#peerError(testPeer, error))
      this.#connections[peerId] = testPeer
      this.#peerTransportKinds.set(peerId, 'webrtc')
      return testPeer
    }

    const peer = new WebRTCPeer({
      initiator: initiator,
      from: this.peerId,
      to: peerId,
      version
    })

    peer.on('signal', (signal) =>
      this.#peerSignal(peer, signal, star, this.version)
    )

    peer.on('connect', () => this.#peerConnect(peer))
    peer.on('close', () => this.#peerClose(peer))
    peer.on('data', (data) => this.#peerData(peer, data))
    peer.on('error', (error) => this.#peerError(peer, error))

    this.#connections[peerId] = peer
    this.#peerTransportKinds.set(peerId, 'webrtc')
    return peer
  }

  #peerJoined = async ({ peerId, version, transport }, star) => {
    // check if peer rejoined before the previous connection closed
    if (this.#connections[peerId]) {
      this.#connections[peerId].destroy()
      delete this.#connections[peerId]
    }

    if (this.peerId === peerId) return

    this.#startPeerTransportAttempt(peerId, star, version, true, transport)

    debug(`peer ${peerId} joined`)
  }

  #inComingSignal = async ({ from, signal, channelName, version }, star) => {
    if (!this.#supportsTransport('webrtc')) {
      debug(
        `ignoring webrtc signal for ${from} because local client does not support webrtc`
      )
      return
    }

    if (version !== this.version) {
      console.warn(
        `${from} joined using the wrong version.\nexpected: ${this.version} but got:${version}`
      )
      return
    }
    if (from === this.peerId) {
      console.warn(`${from} tried to connect to itself.`)
      return
    }
    let peer = this.#connections[from]
    if (peer && String(peer.channelName).startsWith('webtransport:')) {
      if (peer.connected) {
        debug(
          `ignoring webrtc signal for ${from} because peer uses webtransport`
        )
        return
      }

      peer.destroy()
      delete this.#connections[from]
      this.#clearTransportAttempt(from)
      peer = undefined
    }
    if (!peer) {
      this.#clearTransportAttempt(from)
      this.#createRTCPeerConnection(from, star, version)
      peer = this.#connections[from]
    }

    if (peer.connected) {
      debug(`peer ${from} already connected`)
      return
    }

    // peer.channels[channelName]

    if (String(peer.channelName) !== String(channelName)) {
      console.warn(
        `channelNames don't match: got ${peer.channelName}, expected: ${channelName}.`
      )

      peer.destroy()
      delete this.#connections[from]
      this.#clearTransportAttempt(from)
      this.#createRTCPeerConnection(from, star, version, false)
      peer = this.#connections[from]
      if (!peer) return
    }

    peer.signal(signal)
  }

  #peerSignal = (peer, signal, star, version) => {
    let client = this.#stars[star]
    if (!client) client = this.#stars[Object.keys(this.#stars)[0]]

    client.send({
      url: 'signal',
      params: {
        from: this.peerId,
        to: peer.peerId,
        channelName: peer.channelName,
        version,
        signal,
        initiator: peer.initiator
      }
    })
  }

  #peerClose = (peer: PeerConnectionLike) => {
    const wasConnected = peer.connected
    this.#peerTransportKinds.delete(peer.peerId)
    if (this.#connections[peer.peerId]) {
      peer.destroy()
      delete this.#connections[peer.peerId]
    }

    if (!wasConnected && this.#peerTransportAttempts.has(peer.peerId)) {
      this.#advanceTransportAttempt(peer.peerId)
    }

    debug(`closed ${peer.peerId}'s connection`)
  }

  #peerConnect = (peer) => {
    const attempt = this.#peerTransportAttempts.get(peer.peerId)
    const transport =
      this.#peerTransportKinds.get(peer.peerId) ||
      attempt?.order[attempt.index] ||
      'webrtc'
    this.#emitTransportEvent({
      type: 'connected',
      peerId: peer.peerId,
      transport,
      attemptIndex: attempt?.index ?? 0,
      order: attempt ? [...attempt.order] : [transport]
    })
    this.#clearTransportAttempt(peer.peerId)
    debug(`${peer.peerId} connected`)
    globalThis.pubsub.publishVerbose(this.#connectEvent, peer.peerId)
  }

  #noticeMessage = (message, id, from, peer) => {
    const dataOut =
      message instanceof Uint8Array
        ? message
        : new Uint8Array(Object.values(message))
    if (globalThis.pubsub.hasSubscribers(id)) {
      globalThis.pubsub.publish(id, {
        data: dataOut,
        id,
        from,
        peer
      })
    } else {
      globalThis.pubsub.publish('peer:data', {
        data: dataOut,
        id,
        from,
        peer
      })
    }
  }

  #peerData = (peer, data) => {
    const tryJson = () => {
      const parsed = JSON.parse(new TextDecoder().decode(data))
      const { id, size, chunk, index, count } = parsed
      const chunkLength = chunk ? Object.values(chunk).length : size
      return {
        id,
        size: Number(size),
        index: Number(index ?? 0),
        count: Number(count ?? 1),
        chunk: new Uint8Array(Object.values(chunk)),
        flags: 0,
        crc: 0
      }
    }

    const decodeBinary = () => {
      let u8: Uint8Array
      if (typeof data === 'string') {
        // should not happen when sending binary, fallback to JSON
        return tryJson()
      } else if (data instanceof ArrayBuffer) {
        u8 = new Uint8Array(data)
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView & {
          byteOffset?: number
          byteLength?: number
        }
        const byteOffset = (view as any).byteOffset || 0
        const byteLength = (view as any).byteLength || (data as any).length
        u8 = new Uint8Array((view as any).buffer, byteOffset, byteLength)
      } else if (data?.buffer) {
        u8 = new Uint8Array(data.buffer)
      } else {
        // last resort: attempt JSON
        return tryJson()
      }

      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
      let offset = 0
      const version = dv.getUint8(offset)
      offset += 1
      const flags = dv.getUint8(offset)
      offset += 1
      const size = dv.getUint32(offset, true)
      offset += 4
      const index = dv.getUint32(offset, true)
      offset += 4
      const count = dv.getUint32(offset, true)
      offset += 4
      const expectedCrc = dv.getUint32(offset, true)
      offset += 4
      const idLen = dv.getUint16(offset, true)
      offset += 2
      const idBytes = u8.subarray(offset, offset + idLen)
      offset += idLen
      const id = new TextDecoder().decode(idBytes)
      const chunk = u8.subarray(offset)

      return { id, size, index, count, chunk, flags, crc: expectedCrc }
    }

    const frame = decodeBinary()
    peer.bw.down += frame.chunk.length

    // Single frame path: if compressed, inflate before publish
    if (frame.count === 1) {
      let payload = frame.chunk
      const compressed = Boolean(frame.flags & (1 << 1))
      if (compressed) {
        const actualCrc = crc32(payload)
        if (actualCrc !== frame.crc) {
          console.warn(`CRC mismatch: expected ${frame.crc}, got ${actualCrc}`)
        }
        try {
          payload = inflate(payload)
        } catch (e) {
          console.warn('inflate failed, passing compressed payload')
        }
      }
      this.#noticeMessage(payload, frame.id, peer.peerId, peer)
      return
    }

    // Chunked message handling with indexed reassembly
    if (
      !this.#messagesToHandle[frame.id] ||
      Array.isArray(this.#messagesToHandle[frame.id])
    ) {
      this.#messagesToHandle[frame.id] = {
        chunks: new Array(frame.count),
        receivedBytes: 0,
        expectedSize: Number(frame.size),
        expectedCount: Number(frame.count)
      }
    }

    const state = this.#messagesToHandle[frame.id] as {
      chunks: Uint8Array[]
      receivedBytes: number
      expectedSize: number
      expectedCount: number
    }
    // Verify CRC for this chunk
    const actualCrc = crc32(frame.chunk)
    if (actualCrc !== frame.crc) {
      console.warn(
        `Chunk CRC mismatch for ${frame.id}[${frame.index}]: expected ${frame.crc}, got ${actualCrc}`
      )
    }
    state.chunks[frame.index] = frame.chunk
    state.receivedBytes += frame.chunk.length

    // If all chunks present and total size matches, reassemble
    const allPresent = state.chunks.every((c) => c instanceof Uint8Array)
    if (allPresent && state.receivedBytes === state.expectedSize) {
      const result = new Uint8Array(state.expectedSize)
      let offset2 = 0
      for (const c of state.chunks) {
        result.set(c, offset2)
        offset2 += c.length
      }
      let payload = result
      const compressed = Boolean(frame.flags & (1 << 1))
      if (compressed) {
        try {
          payload = inflate(result)
        } catch (e) {
          console.warn('inflate failed, passing compressed payload')
        }
      }
      this.#noticeMessage(payload, frame.id, peer.peerId, peer)
      delete this.#messagesToHandle[frame.id]
    }
  }

  #peerError = (peer: PeerConnectionLike, error: unknown) => {
    const message =
      error instanceof Error ? error.message : `unknown error: ${String(error)}`
    const attempt = this.#peerTransportAttempts.get(peer.peerId)
    const transport =
      this.#peerTransportKinds.get(peer.peerId) ||
      attempt?.order[attempt.index] ||
      'webrtc'
    this.#emitTransportEvent({
      type: 'attempt-error',
      peerId: peer.peerId,
      transport,
      attemptIndex: attempt?.index ?? 0,
      order: attempt ? [...attempt.order] : [transport],
      reason: message
    })
    console.warn(`Connection error: ${message}`)
    peer.destroy()
  }

  async close() {
    for (const peerId of this.#peerTransportAttempts.keys()) {
      this.#clearTransportAttempt(peerId)
    }

    for (const peerId in this.#connections) {
      const peer = this.#connections[peerId]
      if (peer) {
        peer.destroy()
        delete this.#connections[peerId]
      }
    }
    for (const star in this.#stars) {
      // unsubscribe handlers we registered earlier
      const listeners = this.#starListeners[star]
      if (listeners && listeners.length) {
        for (const { topic, handler } of listeners) {
          try {
            this.#stars[star].pubsub.unsubscribe(topic, handler)
          } catch (e) {
            // ignore
          }
        }
      }
      if (this.#stars[star].connectionState() === 'open') {
        await this.#stars[star].send({ url: 'leave', params: this.peerId })
      }
    }

    const peerClosers = Object.values(this.#connections).map((connection) => {
      try {
        // destroy() may be sync or return a promise
        return connection.destroy()
      } catch (e) {
        return undefined
      }
    })

    const starClosers = Object.values(this.#stars).map((connection) => {
      try {
        return connection.close(0)
      } catch (e) {
        return undefined
      }
    })

    return Promise.allSettled([...peerClosers, ...starClosers])
  }
}

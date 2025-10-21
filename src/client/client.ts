import { SocketRequestClient } from 'socket-request-client'
import Peer from './peer.js'
import '@vandeurenglenn/debug'
import { MAX_MESSAGE_SIZE, defaultOptions } from './constants.js'

const debug = globalThis.createDebugger('@netpeer/swarm/client')

export type Options = {
  peerId: string
  networkVersion: string // websocket.protocol
  version: string // version string to pass to a star when connecting
  stars: string[]
  connectEvent?: string
  attempts?: number
  // optional retry/backoff for star connections
  retry?: {
    retries?: number
    factor?: number
    minTimeout?: number
    maxTimeout?: number
  }
}

export default class Client {
  #peerId
  #connections: { [index: string]: Peer } = {}
  #stars: { [index: string]: SocketRequestClient['clientConnection'] } = {}
  #starListeners: {
    [index: string]: { topic: string; handler: (...args: any[]) => void }[]
  } = {}
  #handlersSetup = false
  #reinitLock: Promise<void> | null = null
  #connectEvent = 'peer:connected'
  #retryOptions = { retries: 5, factor: 2, minTimeout: 1000, maxTimeout: 30000 }
  id: string
  networkVersion: string
  starsConfig: string[]
  socketClient: SocketRequestClient
  messageSize = 262144
  version: string

  #messagesToHandle: { [id: string]: any[] } = {}

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
  /**
   *
   * @param options {object}
   * @param options.peerId {string}
   * @param options.networkVersion {string}
   * @param options.version {string}
   * @param options.stars {string[]}
   * @param options.connectEvent {string} defaults to peer:connected, can be renamed to handle different protocols, like peer:discovered (setup peer props before fireing the connect event)
   */
  constructor(options: Options) {
    const { peerId, networkVersion, version, connectEvent, stars } = {
      ...defaultOptions,
      ...options
    }
    this.#peerId = peerId
    this.networkVersion = networkVersion
    this.version = version
    this.#connectEvent = connectEvent
    this.starsConfig = stars
    if (options?.retry)
      this.#retryOptions = { ...this.#retryOptions, ...options.retry }

    this._init()
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
        // clear internal maps so setupStar starts fresh
        this.#stars = {}
        this.#connections = {}

        for (const star of this.starsConfig) {
          try {
            await this.setupStar(star)
          } catch (e) {
            // If last star fails and none connected, surface error
            if (
              this.starsConfig.indexOf(star) === this.starsConfig.length - 1 &&
              Object.keys(this.#stars).length === 0
            )
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
          params: { version: this.version, peerId: this.peerId }
        })
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
    // reconnectJob()

    if (!globalThis.RTCPeerConnection)
      globalThis.wrtc = (await import('@koush/wrtc')).default

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
    // Setup resume/sleep detection so we can reinit connections after wake
    this._setupResumeHandler()
  }

  setupStarListeners(starConnection, starId) {
    // create stable references to handlers so we can unsubscribe later
    const onPeerJoined = (id) => this.#peerJoined(id, starConnection)
    const onPeerLeft = (id) => this.#peerLeft(id, starConnection)
    const onStarJoined = this.#starJoined
    const onStarLeft = this.#starLeft
    const onSignal = (message) => this.#inComingSignal(message, starConnection)

    starConnection.pubsub.subscribe('peer:joined', onPeerJoined)
    starConnection.pubsub.subscribe('peer:left', onPeerLeft)
    starConnection.pubsub.subscribe('star:joined', onStarJoined)
    starConnection.pubsub.subscribe('star:left', onStarLeft)
    starConnection.pubsub.subscribe('signal', onSignal)

    this.#starListeners[starId] = [
      { topic: 'peer:joined', handler: onPeerJoined },
      { topic: 'peer:left', handler: onPeerLeft },
      { topic: 'star:joined', handler: onStarJoined },
      { topic: 'star:left', handler: onStarLeft },
      { topic: 'signal', handler: onSignal }
    ]
  }

  _setupResumeHandler() {
    if (this.#handlersSetup) return
    this.#handlersSetup = true

    const THRESHOLD = 10 * 1000 // 10s gap indicates sleep/wake
    let last = Date.now()

    const check = () => {
      const now = Date.now()
      const delta = now - last
      last = now
      if (delta > THRESHOLD) {
        debug(`resume detected (gap ${delta}ms)`)
        // fire reinit but don't await here
        ;(this as any).reinit().catch((e) => debug('reinit error', e))
      }
    }

    // Start interval checker
    const iv = setInterval(check, 2000)

    // Browser specific events
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          // small delay to let timers update
          setTimeout(() => check(), 50)
        }
      })
      window.addEventListener('online', () => setTimeout(() => check(), 50))
    }

    // Node: listen for SIGCONT (process continued) as well
    if (globalThis.process?.on) {
      try {
        process.on('SIGCONT', () => setTimeout(() => check(), 50))
      } catch (e) {
        // ignore
      }
    }

    // keep reference so it can be cleared on close
    // @ts-ignore
    this._resumeInterval = iv
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

  connect(peerId, star) {
    if (this.#connections[peerId]) {
      debug(`peer ${peerId} already connected`)
      return
    }
    if (this.#stars[star]?.connectionState() !== 'open') {
      console.warn(
        `Star ${star} is not connected, cannot reconnect to peer ${peerId}`
      )
      return
    }
    this.#createRTCPeerConnection(peerId, star, this.version)
  }

  reconnect(peerId, star) {
    delete this.#connections[peerId]
    debug(`reconnecting to peer ${peerId}`)
    return this.connect(peerId, star)
  }

  #createRTCPeerConnection = (peerId, star, version) => {
    const peer = new Peer({
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
  }

  #peerJoined = async ({ peerId, version }, star) => {
    // check if peer rejoined before the previous connection closed
    if (this.#connections[peerId]) {
      this.#connections[peerId].destroy()
      delete this.#connections[peerId]
    }
    if (this.peerId !== peerId)
      this.#createRTCPeerConnection(peerId, star, version)

    debug(`peer ${peerId} joined`)
  }

  #inComingSignal = async ({ from, signal, channelName, version }, star) => {
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
    if (!peer) {
      this.#createRTCPeerConnection(from, star, version)
      peer = this.#connections[from]
    }

    if (peer.connected) {
      debug(`peer ${from} already connected`)
      return
    }

    if (String(peer.channelName) !== String(channelName)) {
      console.warn(
        `channelNames don't match: got ${peer.channelName}, expected: ${channelName}.`
      )

      // Destroy the existing peer connection
      // peer.destroy()
      // delete this.#connections[from]

      // // // Create a new peer connection with the correct configuration
      // this.#createRTCPeerConnection(from, star, version, false)
      // peer = this.#connections[from]
      return
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
        signal
      }
    })
  }

  #peerClose = (peer: Peer) => {
    if (this.#connections[peer.peerId]) {
      peer.destroy()
      delete this.#connections[peer.peerId]
    }

    debug(`closed ${peer.peerId}'s connection`)
  }

  #peerConnect = (peer) => {
    debug(`${peer.peerId} connected`)
    globalThis.pubsub.publishVerbose(this.#connectEvent, peer.peerId)
  }

  #noticeMessage = (message, id, from, peer) => {
    if (globalThis.pubsub.subscribers[id]) {
      globalThis.pubsub.publish(id, {
        data: new Uint8Array(Object.values(message)),
        id,
        from,
        peer
      })
    } else {
      globalThis.pubsub.publish('peer:data', {
        data: new Uint8Array(Object.values(message)),
        id,
        from,
        peer
      })
    }
  }

  #peerData = (peer, data) => {
    const { id, size, chunk } = JSON.parse(new TextDecoder().decode(data))
    peer.bw.down += size

    if (size <= MAX_MESSAGE_SIZE) {
      this.#noticeMessage(chunk, id, peer.peerId, peer)
    } else {
      if (!this.#messagesToHandle[id]) this.#messagesToHandle[id] = []
      this.#messagesToHandle[id] = [
        ...this.#messagesToHandle[id],
        ...Object.values(chunk)
      ]

      if (this.#messagesToHandle[id].length === Number(size)) {
        this.#noticeMessage(this.#messagesToHandle[id], id, peer.peerId, peer)
        delete this.#messagesToHandle[id]
      }
    }
  }

  #peerError = (peer, error) => {
    console.warn(`Connection error: ${error.message}`)
    peer.destroy()
  }

  async close() {
    // clear resume interval if set
    // @ts-ignore
    if (this._resumeInterval) {
      // @ts-ignore
      clearInterval(this._resumeInterval)
      // @ts-ignore
      this._resumeInterval = null
    }
    for (const star in this.#stars) {
      if (this.#stars[star].connectionState() === 'open') {
        await this.#stars[star].send({ url: 'leave', params: this.peerId })
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
      }
    }

    // Ensure we wait for all peer and star close/destroy operations.
    // Previous code passed an array of arrays to Promise.allSettled which
    // resolves immediately; flatten into a single array of promises (or
    // values) so we actually wait for async close operations.
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

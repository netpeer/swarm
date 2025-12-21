import { SocketRequestClient } from 'socket-request-client'
import Peer from './peer.js'
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

export default class Client {
  #peerId
  #connections: { [index: string]: Peer } = {}
  #stars: { [index: string]: SocketRequestClient['clientConnection'] } = {}
  #starListeners: {
    [index: string]: { topic: string; handler: (...args: any[]) => void }[]
  } = {}
  #reinitLock: Promise<void> | null = null
  #connectEvent = 'peer:connected'
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

  connect(peerId, star, initiator = true) {
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
    this.#createRTCPeerConnection(peerId, star, this.version, initiator)
  }

  reconnect(peerId, star, initiator = false) {
    delete this.#connections[peerId]
    debug(`reconnecting to peer ${peerId}`)
    return this.connect(peerId, star, initiator)
  }

  #createRTCPeerConnection = (peerId, star, version, initiator = false) => {
    const peer = new Peer({
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
  }

  #peerJoined = async ({ peerId, version }, star) => {
    // check if peer rejoined before the previous connection closed
    if (this.#connections[peerId]) {
      this.#connections[peerId].destroy()
      delete this.#connections[peerId]
    }
    if (this.peerId !== peerId)
      this.#createRTCPeerConnection(peerId, star, version, true)

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

    // peer.channels[channelName]

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
        signal,
        initiator: peer.initiator
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
    const dataOut =
      message instanceof Uint8Array
        ? message
        : new Uint8Array(Object.values(message))
    if (globalThis.pubsub.subscribers[id]) {
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

  #peerError = (peer, error) => {
    console.warn(`Connection error: ${error.message}`)
    peer.destroy()
  }

  async close() {
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

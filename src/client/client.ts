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
}

export default class Client {
  #peerId
  #connections: { [index: string]: Peer } = {}
  #stars: { [index: string]: SocketRequestClient['clientConnection'] } = {}
  #connectEvent = 'peer:connected'
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

    this._init()
  }

  async _init() {
    // reconnectJob()

    if (!globalThis.RTCPeerConnection)
      globalThis.wrtc = (await import('@koush/wrtc')).default

    for (const star of this.starsConfig) {
      try {
        const client = new SocketRequestClient(star, this.networkVersion)
        this.#stars[star] = await client.init()
        this.setupStarListeners(this.#stars[star])
        this.#stars[star].send({
          url: 'join',
          params: { version: this.version, peerId: this.peerId }
        })
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
      globalThis.addEventListener('beforeunload', async () => this.close())
    }
  }

  setupStarListeners(star) {
    star.pubsub.subscribe('peer:joined', (id) => this.#peerJoined(id, star))
    star.pubsub.subscribe('peer:left', (id) => this.#peerLeft(id, star))
    star.pubsub.subscribe('star:joined', this.#starJoined)
    star.pubsub.subscribe('star:left', this.#starLeft)
    star.pubsub.subscribe('signal', (message) =>
      this.#inComingSignal(message, star)
    )
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

    if (Object.keys(this.#stars).length === 0) {
      for (const star of this.starsConfig) {
        try {
          const socketClient = await new SocketRequestClient(
            star,
            this.networkVersion
          ).init()
          if (!socketClient?.client?.OPEN) return
          this.#stars[star] = socketClient

          this.#stars[star].send({
            url: 'join',
            params: { peerId: this.peerId, version: this.version }
          })
          this.setupStarListeners(socketClient)
        } catch (e) {
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

    if (String(peer.channelName) !== String(channelName)) {
      console.warn(
        `channelNames don't match: got ${peer.channelName}, expected: ${channelName}.`
      )

      // Destroy the existing peer connection
      // peer.destroy()
      // delete this.#connections[from]

      // // Create a new peer connection with the correct configuration
      // this.#createRTCPeerConnection(from, star, version, false)
      // peer = this.#connections[from]
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

  #peerClose = (peer) => {
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
    for (const star in this.#stars) {
      if (this.#stars[star].connectionState() === 'open')
        await this.#stars[star].send({ url: 'leave', params: this.peerId })
    }

    const promises = [
      Object.values(this.#connections).map((connection) =>
        connection.destroy()
      ),
      Object.values(this.#stars).map((connection) => connection.close(0))
    ]

    return Promise.allSettled(promises)
  }
}

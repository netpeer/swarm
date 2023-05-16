import SocketClient from 'socket-request-client'
import Peer from './peer.js'
import '@vandeurenglenn/debug'

export default class Client {
  #peerConnection: RTCPeerConnection
  #connections = {}
  #stars = {}
  id: string
  networkVersion: string
  starsConfig: string[]
  socketClient: SocketClient

  get connections() {
    return { ...this.#connections }
  }

  get peers() {
    return Object.entries(this.#connections)
  }

  constructor(id, networkVersion = 'peach', stars = ['wss://peach.leofcoin.org']) {
    this.id = id || Math.random().toString(36).slice(-12);
    this.peerJoined = this.peerJoined.bind(this)
    this.peerLeft = this.peerLeft.bind(this)
    this.starLeft = this.starLeft.bind(this)
    this.starJoined = this.starJoined.bind(this)
    this.networkVersion = networkVersion

    this._init(stars)
  }

  async _init(stars = []) {
    this.starsConfig = stars
    // reconnectJob()

    if (!globalThis.RTCPeerConnection) globalThis.wrtc = (await import('@koush/wrtc')).default
    else globalThis.wrtc = {
      RTCPeerConnection,
      RTCSessionDescription,
      RTCIceCandidate
    }

    for (const star of stars) {
      try {
        this.socketClient = await SocketClient(star, this.networkVersion)
        const id = await this.socketClient.request({url: 'id', params: {from: this.id}})
        this.socketClient.peerId = id
        this.#stars[id] = this.socketClient
      } catch (e) {
        if (stars.indexOf(star) === stars.length -1 && !this.socketClient) throw new Error(`No star available to connect`);
      }
    }

    this.setupListeners()
    
    const peers = await this.socketClient.peernet.join({id: this.id})
    for (const id of peers) {
      if (id !== this.id && !this.#connections[id]) this.#connections[id] = await new Peer({channelName: `${id}:${this.id}`, socketClient: this.socketClient, id: this.id, to: id, peerId: id})
    }

    pubsub.subscribe('connection closed', (peer) => {
        this.removePeer(peer.peerId)
        setTimeout(() => {
          this.peerJoined(peer.peerId)
        }, 1000)
    })
  }

  setupListeners() {
    this.socketClient.subscribe('peer:joined', this.peerJoined)
    this.socketClient.subscribe('peer:left', this.peerLeft)
    this.socketClient.subscribe('star:left', this.starLeft)
  }

  starJoined(id) {
    if (this.#stars[id]) {
      this.#stars[id].close()
      delete this.#stars[id]
    }
    console.log(`star ${id} joined`);
  }

  async starLeft(id) {
    if (this.#stars[id]) {
      this.#stars[id].close()
      delete this.#stars[id]
    }
    if (this.socketClient?.peerId === id) {

      this.socketClient.unsubscribe('peer:joined', this.peerJoined)
      this.socketClient.unsubscribe('peer:left', this.peerLeft)
      this.socketClient.unsubscribe('star:left', this.starLeft)
      this.socketClient.close()
      this.socketClient = undefined

      for (const star of this.starsConfig) {
        try {
          this.socketClient = await SocketClient(star, this.networkVersion)
          if (!this.socketClient?.client?._connection.connected) return
          const id = await this.socketClient.request({url: 'id', params: {from: this.id}})
          this.#stars[id] = this.socketClient

          this.socketClient.peerId = id

          const peers = await this.socketClient.peernet.join({id: this.id})
          this.setupListeners()
          for (const id of peers) {
            if (id !== this.id) {
              if (!this.#connections[id]) {
                if (id !== this.id) this.#connections[id] = await new Peer({channelName: `${id}:${this.id}`, socketClient: this.socketClient, id: this.id, to: id, peerId: id})
              }
            }

          }
        } catch (e) {
          console.log(e);
          if (this.starsConfig.indexOf(star) === this.starsConfig.length -1 && !this.socketClient) throw new Error(`No star available to connect`);
        }
      }
    }
    globalThis.debug(`star ${id} left`);
  }

  peerLeft(peer) {
    const id = peer.peerId || peer
    if (this.#connections[id]) {
      this.#connections[id].close()
      delete this.#connections[id]
    }
    globalThis.debug(`peer ${id} left`)
  }

  async peerJoined(peer, signal?) {
    const id = peer.peerId || peer
    if (this.#connections[id]) {
      if (this.#connections[id].connected) this.#connections[id].close()
      delete this.#connections[id]
    }
    // RTCPeerConnection
    this.#connections[id] = await new Peer({initiator: true, channelName: `${this.id}:${id}`, socketClient: this.socketClient, id: this.id, to: id, peerId: id})
    
    globalThis.debug(`peer ${id} joined`)
   
  }

  removePeer(peer) {
    const id = peer.peerId || peer
    if (this.#connections[id]) {
      this.#connections[id].connected && this.#connections[id].close()
      delete this.#connections[id]
    }
    globalThis.debug(`peer ${id} removed`)
  }

  async close() {

    this.socketClient.unsubscribe('peer:joined', this.peerJoined)
    this.socketClient.unsubscribe('peer:left', this.peerLeft)
    this.socketClient.unsubscribe('star:left', this.starLeft)

    const promises = [
      Object.values(this.#connections).map(connection => connection.close()),
      Object.values(this.#stars).map(connection => connection.close()),
      this.socketClient.close()
    ]
    
    return Promise.allSettled(promises)
    
  }

}

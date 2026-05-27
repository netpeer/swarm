import { MAX_MESSAGE_SIZE } from './constants.js'
import { PeerCore, type PubSubLike } from './peer-core.js'

export interface NetworkStats {
  latency: number | null
  jitter: number | null
  bytesReceived: number
  bytesSent: number
  packetsLost: number
  fractionLost: number | null
  inboundBitrate: number | null
  outboundBitrate: number | null
  availableOutgoingBitrate: number | null
  timestamp: number
}

const iceServers = [
  {
    urls: 'stun:stun.l.google.com:19302' // Google's public STUN server
  },
  {
    urls: 'stun:openrelay.metered.ca:80'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

type PeerEvent = 'signal' | 'connect' | 'close' | 'data' | 'error'

type WrtcImplementation = {
  RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnection
  RTCSessionDescription?: new (
    descriptionInit: RTCSessionDescriptionInit
  ) => RTCSessionDescription
  RTCIceCandidate?: new (candidateInit: RTCIceCandidateInit) => RTCIceCandidate
}

type SignalPayload = RTCSessionDescriptionInit | RTCIceCandidateInit

export default class WebRTCPeer {
  #pc: RTCPeerConnection
  #listeners: Map<PeerEvent, Set<(...args: unknown[]) => void>> = new Map()
  #pendingCandidates: RTCIceCandidateInit[] = []
  #connected = false
  #destroyed = false
  #trickle = true
  #core: PeerCore
  _pc: RTCPeerConnection
  _channel: RTCDataChannel | null = null
  initiator: boolean
  peerId: string
  channelName: string
  version: string
  compressionThreshold: number = 0.98
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
    initiator?: boolean
    trickle?: boolean
    wrtc?
    config?
    compressionThreshold?: number
  }) {
    const {
      from,
      to,
      initiator,
      trickle,
      config,
      version,
      wrtc,
      compressionThreshold
    } = options

    const rtc = this.#resolveRtc(wrtc)
    const channelName = initiator ? `${from}:${to}` : `${to}:${from}`
    const pc = new rtc.RTCPeerConnection({ iceServers, ...config })

    this.#pc = pc
    this._pc = pc
    this.initiator = Boolean(initiator)
    this.#trickle = trickle ?? true
    this.version = String(version)
    this.peerId = to
    this.channelName = channelName
    if (compressionThreshold !== undefined)
      this.compressionThreshold = compressionThreshold

    this.#setupPeerConnectionHandlers(rtc)
    if (this.initiator) {
      this.#attachDataChannel(this.#pc.createDataChannel(channelName))
      void this.#createOffer()
    }

    this.#core = new PeerCore(
      {
        kind: 'webrtc-datachannel',
        isConnected: () => this.connected,
        sendRaw: (payload) => this.#sendRaw(payload)
      },
      {
        maxMessageSize: MAX_MESSAGE_SIZE,
        compressionThreshold: this.compressionThreshold,
        getBufferedAmount: () => this._channel?.bufferedAmount || 0,
        getPubSub: this.#getPubSub,
        onPayloadSend: (payloadBytes) => {
          this.bw.up += payloadBytes
        }
      }
    )
  }

  #createMessageId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function')
      return randomUUID.call(globalThis.crypto)
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  #resolveRtc(wrtc?: WrtcImplementation): WrtcImplementation {
    if (wrtc) return wrtc

    const globalCandidate = globalThis as unknown as {
      RTCPeerConnection?: WrtcImplementation['RTCPeerConnection']
      RTCSessionDescription?: WrtcImplementation['RTCSessionDescription']
      RTCIceCandidate?: WrtcImplementation['RTCIceCandidate']
      wrtc?: WrtcImplementation
    }

    if (globalCandidate.RTCPeerConnection) {
      return {
        RTCPeerConnection: globalCandidate.RTCPeerConnection,
        RTCSessionDescription: globalCandidate.RTCSessionDescription,
        RTCIceCandidate: globalCandidate.RTCIceCandidate
      }
    }

    if (globalCandidate.wrtc?.RTCPeerConnection) return globalCandidate.wrtc
    throw new Error('No WebRTC implementation available')
  }

  #setupPeerConnectionHandlers(rtc: WrtcImplementation) {
    this.#pc.onicecandidate = (event) => {
      if (this.#destroyed) return
      if (event.candidate && this.#trickle) {
        const payload = event.candidate.toJSON
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              sdpMid: event.candidate.sdpMid,
              usernameFragment: event.candidate.usernameFragment
            }
        this.#emit('signal', payload)
      }

      if (!event.candidate && !this.#trickle && this.#pc.localDescription) {
        this.#emit(
          'signal',
          this.#serializeDescription(this.#pc.localDescription)
        )
      }
    }

    this.#pc.onconnectionstatechange = () => {
      const state = this.#pc.connectionState
      if (state === 'failed' || state === 'closed') this.destroy()
    }

    this.#pc.ondatachannel = (event) => {
      if (!this._channel) this.#attachDataChannel(event.channel)
    }
  }

  #attachDataChannel(channel: RTCDataChannel) {
    this._channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      if (this.#destroyed || this.#connected) return
      this.#connected = true
      this.#emit('connect')
    }

    channel.onclose = () => {
      if (this.#destroyed) return
      this.destroy()
    }

    channel.onerror = () => {
      this.#emit('error', new Error('DataChannel error'))
    }

    channel.onmessage = (event) => {
      this.#emit('data', event.data)
    }
  }

  async #createOffer() {
    try {
      const offer = await this.#pc.createOffer()
      await this.#pc.setLocalDescription(offer)
      if (this.#trickle && this.#pc.localDescription) {
        this.#emit(
          'signal',
          this.#serializeDescription(this.#pc.localDescription)
        )
      }
    } catch (error) {
      this.#emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  async #applyRemoteDescription(
    rtc: WrtcImplementation,
    description: RTCSessionDescriptionInit
  ) {
    const sessionDescription = rtc.RTCSessionDescription
      ? new rtc.RTCSessionDescription(description)
      : description
    await this.#pc.setRemoteDescription(sessionDescription)

    if (description.type === 'offer') {
      const answer = await this.#pc.createAnswer()
      await this.#pc.setLocalDescription(answer)
      if (this.#pc.localDescription) {
        this.#emit(
          'signal',
          this.#serializeDescription(this.#pc.localDescription)
        )
      }
    }

    const pending = [...this.#pendingCandidates]
    this.#pendingCandidates = []
    for (const candidate of pending) {
      // eslint-disable-next-line no-await-in-loop
      await this.#addIceCandidate(rtc, candidate)
    }
  }

  async #addIceCandidate(
    rtc: WrtcImplementation,
    candidate: RTCIceCandidateInit
  ) {
    if (!this.#pc.remoteDescription) {
      this.#pendingCandidates.push(candidate)
      return
    }
    const iceCandidate = rtc.RTCIceCandidate
      ? new rtc.RTCIceCandidate(candidate)
      : candidate
    await this.#pc.addIceCandidate(iceCandidate)
  }

  #serializeDescription(
    description: RTCSessionDescription | RTCSessionDescriptionInit
  ): RTCSessionDescriptionInit {
    return {
      type: description.type,
      sdp: description.sdp || ''
    }
  }

  #sendRaw(payload: Uint8Array) {
    if (!this._channel || this._channel.readyState !== 'open') {
      throw new Error('datachannel is not open')
    }
    this._channel.send(payload)
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

  #emit(event: PeerEvent, ...args: unknown[]) {
    const listeners = this.#listeners.get(event)
    if (!listeners) return
    for (const handler of listeners) handler(...args)
  }

  signal(signalData: SignalPayload) {
    const rtc = this.#resolveRtc()
    void (async () => {
      try {
        const signalCandidate = signalData as Partial<RTCIceCandidateInit>
        if (typeof signalCandidate.candidate === 'string') {
          await this.#addIceCandidate(
            rtc,
            signalCandidate as RTCIceCandidateInit
          )
          return
        }

        const signalDescription =
          signalData as Partial<RTCSessionDescriptionInit>
        if (
          typeof signalDescription.type === 'string' &&
          typeof signalDescription.sdp === 'string'
        ) {
          await this.#applyRemoteDescription(
            rtc,
            signalDescription as RTCSessionDescriptionInit
          )
          return
        }
        throw new Error('invalid signal payload')
      } catch (error) {
        this.#emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })()
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#connected = false

    if (this._channel) {
      this._channel.onopen = null
      this._channel.onclose = null
      this._channel.onmessage = null
      this._channel.onerror = null
      try {
        this._channel.close()
      } catch (e) {}
      this._channel = null
    }

    this.#pc.onicecandidate = null
    this.#pc.onconnectionstatechange = null
    this.#pc.ondatachannel = null
    try {
      this.#pc.close()
    } catch (e) {}

    this.#emit('close')
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

  /**
   * send to peer
   * @param data Uint8Array
   * @param id custom id to listen to
   */
  send(data: Uint8Array, id = this.#createMessageId()) {
    this.#core.send(data, id)
  }

  /**
   * send to peer & wait for response
   * @param data Uint8Array
   * @param id custom id to listen to
   */
  request(data: Uint8Array, id = this.#createMessageId()): Promise<Uint8Array> {
    return this.#core.request(data, id)
  }

  /**
   * Get comprehensive network statistics from WebRTC
   * @returns NetworkStats object with detailed metrics
   */
  async getNetworkStats(): Promise<NetworkStats | null> {
    try {
      const pc = this._pc
      if (!pc) return null

      const stats = await pc.getStats()
      const result: NetworkStats = {
        latency: null,
        jitter: null,
        bytesReceived: 0,
        bytesSent: 0,
        packetsLost: 0,
        fractionLost: null,
        inboundBitrate: null,
        outboundBitrate: null,
        availableOutgoingBitrate: null,
        timestamp: Date.now()
      }

      stats.forEach((report) => {
        const typedReport = report as unknown as Record<string, unknown> & {
          type?: string
          currentRoundTripTime?: number
          bytesReceived?: number
          bytesSent?: number
          packetsLost?: number
          jitter?: number
          fractionLost?: number
          availableOutgoingBitrate?: number
        }
        // Latency from candidate pair
        if (
          typedReport.type === 'candidate-pair' &&
          typeof typedReport.currentRoundTripTime === 'number'
        ) {
          result.latency = Math.round(typedReport.currentRoundTripTime * 1000)
        }

        // Inbound RTP stats
        if (typedReport.type === 'inbound-rtp') {
          result.bytesReceived += Number(typedReport.bytesReceived || 0)
          result.packetsLost += Number(typedReport.packetsLost || 0)
          if (typeof typedReport.jitter === 'number') {
            result.jitter = Math.round(typedReport.jitter * 1000)
          }
          if (typeof typedReport.fractionLost === 'number') {
            result.fractionLost = typedReport.fractionLost
          }
        }

        // Outbound RTP stats
        if (typedReport.type === 'outbound-rtp') {
          result.bytesSent += Number(typedReport.bytesSent || 0)
        }

        // Available bandwidth
        if (
          typedReport.type === 'remote-candidate' &&
          typeof typedReport.availableOutgoingBitrate === 'number'
        ) {
          result.availableOutgoingBitrate = Math.round(
            typedReport.availableOutgoingBitrate
          )
        }
      })
      return result
    } catch (e) {
      return null
    }
  }

  toJSON() {
    return {
      peerId: this.peerId,
      channelName: this.channelName,
      version: this.version,
      bw: this.bw
    }
  }
}

import { MAX_MESSAGE_SIZE } from './constants.js'

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
const SimplePeer = (await import('simple-peer')).default
export default class Peer extends SimplePeer {
  peerId: string
  channelName: string
  version: string
  bw: {
    up: number
    down: number
  } = { up: 0, down: 0 }

  get connected() {
    return super.connected
  }

  constructor(options: {
    from: string
    to: string
    version: string | number
    initiator?: boolean
    trickle?: boolean
    wrtc?
    config?
  }) {
    const { from, to, initiator, trickle, config, version } = options

    const channelName = initiator ? `${from}:${to}` : `${to}:${from}`

    super({
      channelName,
      initiator,
      trickle: trickle || true,
      config: { iceServers, ...config },
      wrtc: globalThis.wrtc
    })
    this.version = String(version)
    this.peerId = to
    this.channelName = channelName
  }

  async #chunkit(data: Uint8Array, id: string) {
    this.bw.up = data.length
    const size = data.length

    // no needles chunking, keep it simple, if data is smaller then max size just send it
    if (data.length <= MAX_MESSAGE_SIZE) {
      return super.send(JSON.stringify({ chunk: data, id, size: data.length }))
    }

    async function* chunks(data: Uint8Array) {
      while (data.length !== 0) {
        const amountToSlice =
          data.length >= MAX_MESSAGE_SIZE ? MAX_MESSAGE_SIZE : data.length
        const subArray = data.subarray(0, amountToSlice)
        data = data.subarray(amountToSlice, data.length)
        yield subArray
        // super.send(JSON.stringify({ chunk: subArray, id, size }))
      }
    }

    // while (data.length !== 0) {
    //   const amountToSlice =
    //     data.length >= MAX_MESSAGE_SIZE ? MAX_MESSAGE_SIZE : data.length
    //   const subArray = data.subarray(0, amountToSlice)
    //   data = data.subarray(amountToSlice, data.length)
    //   super.send(JSON.stringify({ chunk: subArray, id, size }))
    // }

    for await (const chunk of chunks(data)) {
      super.send(JSON.stringify({ chunk, id, size }))
    }
  }

  /**
   * send to peer
   * @param data ArrayLike
   * @param id custom id to listen to
   */
  send(data, id = crypto.randomUUID()) {
    // send chuncks till ndata support for SCTP is added
    // wraps data
    this.#chunkit(data, id)
  }

  /**
   * send to peer & wait for response
   * @param data ArrayLike
   * @param id custom id to listen to
   */
  request(data, id = crypto.randomUUID()) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(`request for ${id} timed out`),
        30_000
      )
      const onrequest = ({ data }) => {
        clearTimeout(timeout)
        resolve(data)
        globalThis.pubsub.unsubscribe(id, onrequest)
      }
      globalThis.pubsub.subscribe(id, onrequest)
      this.send(data, id)
    })
  }
}

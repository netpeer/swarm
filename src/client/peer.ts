import { MAX_MESSAGE_SIZE } from './constants.js'
import { deflate } from 'pako'

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
  compressionThreshold: number = 0.98
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

    const channelName = initiator ? `${from}:${to}` : `${to}:${from}`

    super({
      channelName,
      initiator,
      trickle: trickle ?? true,
      config: { iceServers, ...config },
      wrtc: wrtc ?? globalThis.wrtc
    })
    this.version = String(version)
    this.peerId = to
    this.channelName = channelName
    if (compressionThreshold !== undefined)
      this.compressionThreshold = compressionThreshold
  }

  async #chunkit(data: Uint8Array, id: string) {
    this.bw.up = data.length
    // attempt compression; use compressed only if beneficial
    let sendData = data
    try {
      const c = deflate(data)
      if (c?.length && c.length < data.length * this.compressionThreshold)
        sendData = c
    } catch (e) {
      // ignore
    }
    const size = sendData.length

    const encodeFrame = (
      idStr: string,
      totalSize: number,
      index: number,
      count: number,
      payload: Uint8Array,
      flags: number
    ): Uint8Array => {
      const te = new TextEncoder()
      const idBytes = te.encode(idStr)
      const crc = crc32(payload)
      const headerLen = 1 + 1 + 4 + 4 + 4 + 4 + 2 + idBytes.length
      const buffer = new ArrayBuffer(headerLen + payload.length)
      const view = new DataView(buffer)
      const out = new Uint8Array(buffer)

      let offset = 0
      view.setUint8(offset, 1) // version
      offset += 1
      view.setUint8(offset, flags) // flags: bit0 chunked, bit1 compressed
      offset += 1
      view.setUint32(offset, totalSize, true)
      offset += 4
      view.setUint32(offset, index, true)
      offset += 4
      view.setUint32(offset, count, true)
      offset += 4
      view.setUint32(offset, crc, true) // CRC32
      offset += 4
      view.setUint16(offset, idBytes.length, true)
      offset += 2
      out.set(idBytes, offset)
      offset += idBytes.length
      out.set(payload, offset)
      return out
    }

    // no needles chunking, keep it simple, if data is smaller then max size just send it
    if (size <= MAX_MESSAGE_SIZE) {
      const flags =
        ((size > MAX_MESSAGE_SIZE ? 1 : 0) << 0) |
        ((sendData !== data ? 1 : 0) << 1)
      super.send(encodeFrame(id, size, 0, 1, sendData, flags))
      return
    }

    function* chunks(data: Uint8Array) {
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

    // backpressure-aware send loop with indexed chunks
    const count = Math.ceil(size / MAX_MESSAGE_SIZE)
    let index = 0
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const threshold = 4 * 1024 * 1024 // 4MB bufferedAmount threshold

    const flags = (1 << 0) | ((sendData !== data ? 1 : 0) << 1)
    for (const chunk of chunks(sendData)) {
      // wait while channel is congested
      // eslint-disable-next-line no-await-in-loop
      while (
        // @ts-ignore underlying channel is not part of public types
        (this as any)._channel?.bufferedAmount > threshold
      ) {
        // if connection closed, abort
        // eslint-disable-next-line no-await-in-loop
        if (!this.connected) return
        // eslint-disable-next-line no-await-in-loop
        await sleep(10)
      }

      super.send(encodeFrame(id, size, index, count, chunk, flags))
      index += 1
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
      let timeout: ReturnType<typeof setTimeout>
      const onrequest = ({ data }) => {
        clearTimeout(timeout)
        resolve(data)
        globalThis.pubsub.unsubscribe(id, onrequest)
      }
      timeout = setTimeout(() => {
        globalThis.pubsub.unsubscribe(id, onrequest)
        reject(`request for ${id} timed out`)
      }, 30_000)
      globalThis.pubsub.subscribe(id, onrequest)
      this.send(data, id)
    })
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

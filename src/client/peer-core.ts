import { deflate } from 'pako'

export type PubSubMessage = {
  data: Uint8Array
}

export type PubSubLike = {
  subscribe: (topic: string, handler: (message: PubSubMessage) => void) => void
  unsubscribe: (
    topic: string,
    handler: (message: PubSubMessage) => void
  ) => void
}

export type PeerCoreTransport = {
  kind: string
  isConnected: () => boolean
  sendRaw: (payload: Uint8Array) => void
}

type PeerCoreOptions = {
  maxMessageSize: number
  compressionThreshold: number
  getPubSub: () => PubSubLike | null
  getBufferedAmount?: () => number
  onPayloadSend?: (payloadBytes: number) => void
}

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

export class PeerCore {
  readonly transport: PeerCoreTransport
  readonly options: PeerCoreOptions

  constructor(transport: PeerCoreTransport, options: PeerCoreOptions) {
    this.transport = transport
    this.options = options
  }

  #createMessageId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function')
      return randomUUID.call(globalThis.crypto)
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  #encodeFrame(
    id: string,
    totalSize: number,
    index: number,
    count: number,
    payload: Uint8Array,
    flags: number
  ): Uint8Array {
    const te = new TextEncoder()
    const idBytes = te.encode(id)
    const crc = crc32(payload)
    const headerLen = 1 + 1 + 4 + 4 + 4 + 4 + 2 + idBytes.length
    const buffer = new ArrayBuffer(headerLen + payload.length)
    const view = new DataView(buffer)
    const out = new Uint8Array(buffer)

    let offset = 0
    view.setUint8(offset, 1)
    offset += 1
    view.setUint8(offset, flags)
    offset += 1
    view.setUint32(offset, totalSize, true)
    offset += 4
    view.setUint32(offset, index, true)
    offset += 4
    view.setUint32(offset, count, true)
    offset += 4
    view.setUint32(offset, crc, true)
    offset += 4
    view.setUint16(offset, idBytes.length, true)
    offset += 2
    out.set(idBytes, offset)
    offset += idBytes.length
    out.set(payload, offset)
    return out
  }

  async #chunkAndSend(data: Uint8Array, id: string) {
    if (!this.transport.isConnected()) return

    this.options.onPayloadSend?.(data.length)

    let sendData = data
    try {
      const compressed = deflate(data)
      if (
        compressed?.length &&
        compressed.length < data.length * this.options.compressionThreshold
      ) {
        sendData = compressed
      }
    } catch (e) {}

    const size = sendData.length
    if (size <= this.options.maxMessageSize) {
      if (!this.transport.isConnected()) return
      const flags = (sendData !== data ? 1 : 0) << 1
      this.transport.sendRaw(this.#encodeFrame(id, size, 0, 1, sendData, flags))
      return
    }

    const threshold = 4 * 1024 * 1024
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    const count = Math.ceil(size / this.options.maxMessageSize)
    const flags = (1 << 0) | ((sendData !== data ? 1 : 0) << 1)

    let index = 0
    let remaining = sendData
    while (remaining.length !== 0) {
      const amountToSlice =
        remaining.length >= this.options.maxMessageSize
          ? this.options.maxMessageSize
          : remaining.length
      const chunk = remaining.subarray(0, amountToSlice)
      remaining = remaining.subarray(amountToSlice)

      while ((this.options.getBufferedAmount?.() || 0) > threshold) {
        if (!this.transport.isConnected()) return
        // eslint-disable-next-line no-await-in-loop
        await sleep(10)
      }

      if (!this.transport.isConnected()) return
      this.transport.sendRaw(
        this.#encodeFrame(id, size, index, count, chunk, flags)
      )
      index += 1
    }
  }

  send(data: Uint8Array, id = this.#createMessageId()) {
    void this.#chunkAndSend(data, id).catch(() => {})
  }

  request(data: Uint8Array, id = this.#createMessageId()): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (!this.transport.isConnected()) {
        reject(new Error('peer is not connected'))
        return
      }

      const pubsub = this.options.getPubSub()
      if (!pubsub) {
        reject(new Error('globalThis.pubsub is not available'))
        return
      }

      let timeout: ReturnType<typeof setTimeout>
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        try {
          pubsub.unsubscribe(id, onrequest)
        } catch (e) {}
        fn()
      }

      const onrequest = ({ data }: PubSubMessage) => {
        finish(() => resolve(data))
      }

      timeout = setTimeout(() => {
        finish(() => reject(new Error(`request for ${id} timed out`)))
      }, 30_000)

      try {
        pubsub.subscribe(id, onrequest)
      } catch (error) {
        finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
        return
      }

      if (!this.transport.isConnected()) {
        finish(() => reject(new Error('peer disconnected before request send')))
        return
      }

      void this.#chunkAndSend(data, id).catch((error) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      })
    })
  }
}

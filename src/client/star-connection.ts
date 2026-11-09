import { encodeWire, decodeWire } from '@leofcoin/binary'
import { STAR_PROTOCOL } from '../namespace.js'

export const MAX_STAR_MESSAGE_BYTES = 1024 * 1024
export const starCodec = {
  encode: (value: unknown) => encodeWire('star/3', value, {maxBytes:MAX_STAR_MESSAGE_BYTES}),
  decode: (value: Uint8Array) => decodeWire('star/3', value, {maxBytes:MAX_STAR_MESSAGE_BYTES}) as any
}

/** Native WebSocket in Node and browsers. No JSON fallback on the multiplexed protocol. */
export class StarConnection {
  #socket!: WebSocket
  #handlers = new Map<string,Set<(value: any) => any>>()
  #pending = new Map<string,{resolve:Function;reject:Function;timer:ReturnType<typeof setTimeout>}>()
  #intentional = false
  readonly url: string
  pubsub = {
    subscribe: (topic: string, handler: (value: any) => any) => {
      if (!this.#handlers.has(topic)) this.#handlers.set(topic,new Set())
      this.#handlers.get(topic)!.add(handler)
    },
    unsubscribe: (topic: string, handler: (value: any) => any) => this.#handlers.get(topic)?.delete(handler)
  }

  constructor(url: string) { this.url = url }

  #emit(topic: string, value: unknown) {
    for (const handler of this.#handlers.get(topic) || []) {
      try { void Promise.resolve(handler(value)).catch(() => {}) } catch {}
    }
  }

  init(): Promise<StarConnection> {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Star WebSocket connection timed out')) },10000)
      let socket: WebSocket
      try { socket = this.#socket = new WebSocket(this.url,STAR_PROTOCOL) }
      catch (error) { clearTimeout(timer); reject(error); return }
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => { clearTimeout(timer); resolve(this) }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Star WebSocket connection failed')) }
      socket.onmessage = event => {
        try {
          if (!(event.data instanceof ArrayBuffer)) throw new Error('Binary Star response required')
          const message = starCodec.decode(new Uint8Array(event.data))
          if (!message || typeof message.url !== 'string') throw new Error('Invalid Star response')
          const pending = typeof message.id === 'string' && this.#pending.get(message.id)
          if (pending) {
            clearTimeout(pending.timer); this.#pending.delete(message.id)
            if (message.status >= 400) pending.reject(new Error('Star request refused'))
            else pending.resolve(message.value)
          } else this.#emit(message.url,message.value)
        } catch { this.close(4002) }
      }
      socket.onclose = () => {
        clearTimeout(timer); reject(new Error('Star WebSocket closed before registration'))
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Star connection closed')) }
        this.#pending.clear()
        if (!this.#intentional) this.#emit('star:left',this.url)
      }
    })
  }

  connectionState() { return this.#socket?.readyState === 1 ? 'open' : 'closed' }
  send(value: unknown) {
    if (this.connectionState() !== 'open') throw new Error('Star connection is not open')
    this.#socket.send(new Uint8Array(starCodec.encode(value)).buffer)
  }
  request(value: {url:string;params?:unknown}, timeoutMs = 10000): Promise<any> {
    if (this.#pending.size >= 128) return Promise.reject(new Error('Star request capacity reached'))
    const id = crypto.randomUUID()
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Star request timed out')) },timeoutMs)
      this.#pending.set(id,{resolve,reject,timer})
      try { this.send({...value,id}) } catch(error) { clearTimeout(timer); this.#pending.delete(id); reject(error) }
    })
  }
  close(code = 1000) {
    this.#intentional = true
    // Native browser/Node WebSocket only permits 1000 or application codes.
    this.#socket?.close(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999) ? code : 1000)
  }
}

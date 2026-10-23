// WebTransport streams carry bytes, not application message boundaries.
export const MAX_FRAME_BYTES = 64 * 1024

export const encodeFrame = (payload) => {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > MAX_FRAME_BYTES) {
    throw new Error('invalid transport frame length')
  }
  const frame = new Uint8Array(payload.length + 4)
  new DataView(frame.buffer).setUint32(0, payload.length)
  frame.set(payload, 4)
  return frame
}

export class FrameReader {
  constructor(reader) { this.reader = reader; this.chunk = new Uint8Array(); this.offset = 0 }
  async exact(length, allowEnd = false) {
    const result = new Uint8Array(length)
    let written = 0
    while (written < length) {
      if (this.offset === this.chunk.length) {
        const { done, value } = await this.reader.read()
        if (done) {
          if (allowEnd && written === 0) return null
          throw new Error('truncated transport frame')
        }
        this.chunk = value
        this.offset = 0
        if (!value?.length) continue
      }
      const count = Math.min(length - written, this.chunk.length - this.offset)
      result.set(this.chunk.subarray(this.offset, this.offset + count), written)
      this.offset += count
      written += count
    }
    return result
  }
  async read() {
    const header = await this.exact(4, true)
    if (!header) return null
    const length = new DataView(header.buffer).getUint32(0)
    if (!length || length > MAX_FRAME_BYTES) throw new Error('invalid transport frame length')
    return this.exact(length)
  }
}

export const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value))
export const parseJson = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

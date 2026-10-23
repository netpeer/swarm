import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export class RelayTickets {
  constructor(secret) {
    if (Buffer.byteLength(secret || '') < 32) throw new Error('relay secret must contain at least 32 bytes')
    this.secret = secret
    this.used = new Map()
  }
  sign(body) { return createHmac('sha256', this.secret).update(body).digest() }
  issue(from, to, network, version) {
    const body = Buffer.from(JSON.stringify({ from, to, network, version, exp: Date.now() + 30_000, nonce: randomUUID() })).toString('base64url')
    return `${body}.${this.sign(body).toString('base64url')}`
  }
  consume(token) {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('invalid relay ticket')
    const [body, signature, extra] = token.split('.')
    const actual = Buffer.from(signature || '', 'base64url')
    const expected = this.sign(body || '')
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid relay ticket')
    const value = JSON.parse(Buffer.from(body, 'base64url').toString())
    const now = Date.now()
    if (!Number.isSafeInteger(value.exp) || value.exp <= now || value.exp > now + 30_000 ||
        !['from', 'to', 'network', 'version', 'nonce'].every(key => typeof value[key] === 'string' && value[key].length > 0) || value.from === value.to) throw new Error('invalid relay ticket')
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce)
    if (this.used.has(value.nonce) || this.used.size >= 10_000) throw new Error('replayed ticket or relay ticket capacity reached')
    this.used.set(value.nonce, value.exp)
    return value
  }
}

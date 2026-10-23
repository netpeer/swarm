import { FrameReader, encodeFrame, jsonBytes, parseJson } from '../transport-frames.js'
import { RelayTickets } from './relay-tickets.js'

// One authenticated bidirectional stream per session. Both directions must join
// before either endpoint is reported connected. No echo/open destination proxy.
export class WebTransportRelay {
  constructor({ secret, maxSessions = 256, timeoutMs = 10_000 }) {
    this.tickets = new RelayTickets(secret)
    this.maxSessions = maxSessions
    this.timeoutMs = timeoutMs
    this.sessions = new Set()
    this.waiting = new Map()
  }
  async accept(session) {
    if (this.sessions.size >= this.maxSessions) { session.close(); return }
    const entry = { session, partner: null, key: null, closed: false }
    this.sessions.add(entry)
    const close = () => {
      if (entry.closed) return
      entry.closed = true
      clearTimeout(entry.timer)
      entry.paired?.()
      this.sessions.delete(entry)
      if (this.waiting.get(entry.key) === entry) this.waiting.delete(entry.key)
      session.close()
      if (entry.partner) entry.partner.close()
    }
    entry.close = close
    entry.timer = setTimeout(close, this.timeoutMs)
    void session.closed.then(close, close)
    try {
      const streams = session.incomingBidirectionalStreams.getReader()
      const { done, value: stream } = await streams.read()
      if (done || entry.closed) return close()
      // Refuse extra streams; the relay wire protocol uses exactly one.
      void streams.read().then(({ done, value }) => {
        if (!done) { void value.readable.cancel().catch(() => {}); close() }
      }, close)
      entry.writer = stream.writable.getWriter()
      const frames = new FrameReader(stream.readable.getReader())
      const hello = parseJson(await frames.read())
      if (hello.protocol !== 'swarm-relay/1') throw new Error('unsupported relay protocol')
      const claims = this.tickets.consume(hello.ticket)
      const { from, to, network, version } = claims
      entry.key = JSON.stringify([network, version, from, to])
      const reverse = JSON.stringify([network, version, to, from])
      if (entry.closed) return
      if (this.waiting.has(entry.key)) throw new Error('duplicate relay session')
      const partner = this.waiting.get(reverse)
      if (!partner) {
        this.waiting.set(entry.key, entry)
        await new Promise(resolve => { entry.paired = resolve })
      } else {
        this.waiting.delete(reverse)
        entry.partner = partner
        partner.partner = entry
        partner.paired()
      }
      if (entry.closed || !entry.partner || entry.partner.closed) return close()
      clearTimeout(entry.timer)
      await entry.writer.write(encodeFrame(jsonBytes({ protocol: 'swarm-relay/1', peerId: to, version })))
      while (!entry.closed) {
        const frame = await frames.read()
        if (!frame) break
        await entry.partner.writer.write(encodeFrame(frame))
      }
    } catch (_) {
      // Tickets and payloads must not appear in logs.
    } finally { close() }
  }
  close() { for (const entry of [...this.sessions]) entry.close() }
}

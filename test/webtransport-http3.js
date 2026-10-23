// Real QUIC/TLS test: no HTTP/2 fallback. Kept separate because it needs the
// optional native QUIC package and permission to bind a local UDP socket.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { X509Certificate, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { Http3Server, WebTransport, quicheLoaded } from '@fails-components/webtransport'
import { WebTransportRelay } from '../exports/webtransport-relay.js'
import { RelayTickets } from '../exports/relay-tickets.js'
import { FrameReader, encodeFrame, jsonBytes, parseJson } from '../exports/transport-frames.js'

const temp = mkdtempSync(join(tmpdir(), 'swarm-http3-test-'))
const secret = randomBytes(32).toString('hex')
const relay = new WebTransportRelay({ secret, timeoutMs: 4000 })
let server
const sessions = []
const deadline = setTimeout(() => { console.error('HTTP/3 integration timed out'); process.exit(1) }, 15_000)
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' })
  const cert = readFileSync(join(temp, 'cert.pem'), 'utf8')
  await quicheLoaded
  server = new Http3Server({ host: '127.0.0.1', port: 0, secret, cert, privKey: readFileSync(join(temp, 'key.pem'), 'utf8') })
  const reader = server.sessionStream('/swarm').getReader()
  server.startServer()
  await server.ready
  void (async () => {
    while (true) { const { done, value } = await reader.read(); if (done) break; void relay.accept(value) }
  })().catch(() => {})
  const address = server.address()
  const tickets = new RelayTickets(secret)
  const connect = async (from, to) => {
    const session = new WebTransport(`https://127.0.0.1:${address.port}/swarm`, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new X509Certificate(cert).fingerprint256.split(':').map(x => parseInt(x, 16)).reduce((a, x, i) => { a[i] = x; return a }, new Uint8Array(32)) }]
    })
    sessions.push(session)
    void session.closed.catch(() => {})
    await session.ready
    const stream = await session.createBidirectionalStream()
    const writer = stream.writable.getWriter()
    const frames = new FrameReader(stream.readable.getReader())
    await writer.write(encodeFrame(jsonBytes({ protocol: 'swarm-relay/1', ticket: tickets.issue(from, to, 'peach', '0.4.0') })))
    assert.equal(parseJson(await frames.read()).peerId, to)
    return { writer, frames }
  }
  const [a, b] = await Promise.all([connect('a', 'b'), connect('b', 'a')])
  const payload = randomBytes(48_000)
  // Deliberately split one frame and coalesce the next two.
  const frame = encodeFrame(payload)
  await a.writer.write(frame.subarray(0, 7))
  await a.writer.write(frame.subarray(7))
  assert.deepEqual(await b.frames.read(), new Uint8Array(payload))
  const f = encodeFrame(new Uint8Array([1, 2]))
  await b.writer.write(new Uint8Array([...f, ...f]))
  assert.deepEqual(await a.frames.read(), new Uint8Array([1, 2]))
  assert.deepEqual(await a.frames.read(), new Uint8Array([1, 2]))
  console.log('PASS: real HTTP/3 QUIC relay, authenticated pairing and bidirectional framed payloads')
} finally {
  clearTimeout(deadline)
  for (const session of sessions) session.close()
  relay.close()
  server?.stopServer()
  rmSync(temp, { recursive: true, force: true })
}

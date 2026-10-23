import test from 'node:test'
import assert from 'node:assert/strict'
import CircuitPeer from '../exports/circuit-peer.js'
import WebTransportPeer from '../exports/webtransport-peer.js'
import { encodeFrame, FrameReader, jsonBytes } from '../exports/transport-frames.js'
import { RelayTickets } from '../exports/relay-tickets.js'
import { WebTransportRelay } from '../exports/webtransport-relay.js'
import Client from '../exports/client.js'

const secret = 'test-only-secret-with-at-least-32-bytes'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('relay discovery uses trusted star metadata once and honors explicit opt-out', () => {
  for (const restricted of [false, true]) {
    const client = new Client({ peerId: 'a', version: '0.4.0', networkVersion: 'peach', stars: [],
      testHooks: { skipInit: true }, ...(restricted ? { transport: { kinds: ['webrtc'] } } : {}) })
    const handlers = new Map(), sent = []
    const star = { pubsub: { subscribe: (topic, handler) => handlers.set(topic, handler) }, send: message => sent.push(message) }
    client.setupStarListeners(star, 'test-star')
    const announce = handlers.get('relay:ready')
    announce({ protocol: 'swarm-relay/1', url: 'http://insecure.invalid/swarm' })
    announce({ protocol: 'unknown', url: 'https://relay.invalid/swarm' })
    announce({ protocol: 'swarm-relay/1', url: 'https://user:password@relay.invalid/swarm' })
    assert.equal(sent.length, 0)
    announce({ protocol: 'swarm-relay/1', url: 'https://relay.invalid/swarm' })
    announce({ protocol: 'swarm-relay/1', url: 'https://relay.invalid/swarm' })
    assert.equal(sent.length, restricted ? 0 : 1)
    if (!restricted) assert.ok(sent[0].params.transport.kinds.includes('webtransport'))
  }
})

test('circuit is connected only after handshake and ignores late success after destroy', async () => {
  let resolve
  const peer = new CircuitPeer({ from: 'a', to: 'b', version: '1', handshake: () => new Promise(r => { resolve = r }), sendViaCircuit: async () => {} })
  let connected = 0
  peer.on('connect', () => connected++)
  await tick()
  assert.equal(peer.connected, false)
  resolve()
  await tick()
  assert.equal(connected, 1)
  peer.destroy()
  const late = new CircuitPeer({ from: 'a', to: 'b', version: '1', handshake: () => new Promise(r => { resolve = r }), sendViaCircuit: async () => {} })
  await tick(); late.destroy(); resolve(); await tick()
  assert.equal(late.connected, false)
})

test('failed circuit handshake closes without publishing connect', async () => {
  const peer = new CircuitPeer({ from: 'a', to: 'b', version: '1', handshake: async () => { throw new Error('unreachable') }, sendViaCircuit: async () => {} })
  const events = []
  for (const event of ['error', 'connect', 'close']) peer.on(event, () => events.push(event))
  await tick()
  assert.deepEqual(events, ['error', 'close'])
})

test('frames survive arbitrary split/coalesced byte-stream reads', async () => {
  const a = encodeFrame(new Uint8Array([1, 2, 3]))
  const b = encodeFrame(new Uint8Array([4, 5]))
  const bytes = new Uint8Array([...a, ...b])
  for (let split = 1; split < bytes.length; split++) {
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close() } })
    const reader = new FrameReader(stream.getReader())
    assert.deepEqual(await reader.read(), new Uint8Array([1, 2, 3]))
    assert.deepEqual(await reader.read(), new Uint8Array([4, 5]))
    assert.equal(await reader.read(), null)
  }
})

test('invalid and truncated frames are rejected before unbounded allocation', async () => {
  for (const bytes of [new Uint8Array([255,255,255,255]), new Uint8Array([0,0,0,0]), new Uint8Array([0,0,0,3,1])]) {
    const reader = new FrameReader(new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }).getReader())
    await assert.rejects(reader.read(), /frame/)
  }
})

test('relay tickets reject tampering, wrong secrets, expiry and replay', () => {
  const issuer = new RelayTickets(secret)
  const consumer = new RelayTickets(secret)
  const ticket = issuer.issue('a', 'b', 'peach', '0.4.0')
  assert.equal(consumer.consume(ticket).to, 'b')
  assert.throws(() => consumer.consume(ticket), /replayed/)
  assert.throws(() => new RelayTickets('another-secret-with-at-least-32-bytes').consume(ticket), /invalid/)
  assert.throws(() => consumer.consume('x' + ticket), /invalid/)
  const body = Buffer.from(JSON.stringify({ from: 'a', to: 'b', network: 'peach', version: '1', nonce: 'n', exp: Date.now() - 1 })).toString('base64url')
  assert.throws(() => consumer.consume(`${body}.${issuer.sign(body).toString('base64url')}`), /invalid/)
})

// In-memory sessions exercise the real relay and client; they are not HTTP/3 proof.
const makeSession = () => {
  const up = new TransformStream()
  const down = new TransformStream()
  let finish
  const closed = new Promise(resolve => { finish = resolve })
  const session = {
    closed, close: () => finish(),
    incomingBidirectionalStreams: new ReadableStream({ start(c) { c.enqueue({ readable: up.readable, writable: down.writable }) } })
  }
  return { session, closed, close: () => finish(), ready: Promise.resolve(), createBidirectionalStream: async () => ({ readable: down.readable, writable: up.writable }) }
}

test('two authenticated peers exchange framed payloads through relay, never echo', { timeout: 3000 }, async () => {
  const relay = new WebTransportRelay({ secret, timeoutMs: 1000 })
  const tickets = new RelayTickets(secret)
  const prior = globalThis.WebTransport
  const sessions = []
  globalThis.WebTransport = class {
    constructor() { const pair = makeSession(); sessions.push(pair); void relay.accept(pair.session); return pair }
  }
  const create = (from, to) => new WebTransportPeer({ from, to, version: '0.4.0', url: 'https://relay.invalid/swarm', getTicket: async () => tickets.issue(from, to, 'peach', '0.4.0') })
  const a = create('a', 'b')
  const b = create('b', 'a')
  const connected = peer => new Promise((resolve, reject) => { peer.on('connect', resolve); peer.on('error', reject) })
  try {
    await Promise.all([connected(a), connected(b)])
    const received = new Promise(resolve => b.on('data', resolve))
    // Send raw stream frames to avoid coupling this test to PeerCore encoding.
    const noEcho = []
    a.on('data', bytes => noEcho.push(bytes))
    a.send(new Uint8Array([10,20,30]))
    assert.ok((await received).length > 0)
    assert.equal(noEcho.length, 0)
  } finally { a.destroy(); b.destroy(); relay.close(); globalThis.WebTransport = prior }
})

test('relay closes an unpaired session within configured timeout', { timeout: 1000 }, async () => {
  const relay = new WebTransportRelay({ secret, timeoutMs: 20 })
  const pair = makeSession()
  void relay.accept(pair.session)
  const stream = await pair.createBidirectionalStream()
  await stream.writable.getWriter().write(encodeFrame(jsonBytes({ protocol: 'swarm-relay/1', ticket: new RelayTickets(secret).issue('a', 'b', 'peach', '1') })))
  await pair.closed
  assert.equal(relay.sessions.size, 0)
  assert.equal(relay.waiting.size, 0)
})

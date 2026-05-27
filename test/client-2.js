import Client from '../exports/client.js'
globalThis.DEBUG = true

const transportKinds = (process.env.SWARM_TEST_TRANSPORT_KINDS_PEER2 || '')
  .split(',')
  .map((kind) => kind.trim())
  .filter(Boolean)

const transport =
  transportKinds.length || process.env.SWARM_TEST_TRANSPORT_KIND_PEER2
    ? {
        ...(process.env.SWARM_TEST_TRANSPORT_KIND_PEER2
          ? { kind: process.env.SWARM_TEST_TRANSPORT_KIND_PEER2 }
          : {}),
        ...(transportKinds.length ? { kinds: transportKinds } : {}),
        ...(process.env.SWARM_TEST_TRANSPORT_PREFERRED_PEER2
          ? { preferredKind: process.env.SWARM_TEST_TRANSPORT_PREFERRED_PEER2 }
          : {}),
        webtransport: {
          urlTemplate:
            process.env.SWARM_TEST_WEBTRANSPORT_URL_TEMPLATE ||
            'https://127.0.0.1:65535/echo?peer={peerId}&self={selfId}'
        }
      }
    : undefined

const client = new Client({
  peerId: 'peer-2',
  networkVersion: 'peach',
  version: 1,
  ...(transport ? { transport } : {}),
  stars: [
    process.env.SWARM_TEST_STAR_URL ||
      `ws://localhost:${process.env.SWARM_TEST_PORT || '44444'}`
  ]
})
const message = new Uint8Array(64 * 1024)
const mode = process.env.SWARM_TEST_MODE || 'peer'

if (mode === 'circuit') {
  client.onCircuit('echo', async (payload, context) => {
    return {
      ok: true,
      from: context.from,
      method: context.method,
      payload
    }
  })
}

if (mode === 'server-request') {
  client.onCircuit('server:echo', async (payload, context) => {
    return {
      ok: true,
      from: context.from,
      method: context.method,
      payload
    }
  })
}

pubsub.subscribe('hello', (data) => {
  const peer = client.getPeer('peer-1')
  peer.send(new TextEncoder().encode('hi'), 'hello')
})

pubsub.subscribe('peer:data', (data) => {
  console.log({ data })
})
pubsub.subscribe('peer:connected', (peerId) => {
  console.log('connected: ' + peerId)
  const peer = client.getPeer(peerId)
  console.log({ peerVersion: peer.version })
  // peer.send(message)
})

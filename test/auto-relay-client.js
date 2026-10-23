import { EventEmitter } from 'node:events'
import { WebTransport } from '@fails-components/webtransport'
import Client from '../exports/client.js'

// Test-only certificate pin. Production uses the normal trust store.
globalThis.WebTransport = class extends WebTransport {
  constructor(url) { super(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(JSON.parse(process.env.TEST_CERT_HASH)) }] }) }
}
const id = process.env.TEST_PEER_ID
let provedTransport = false
const client = new Client({
  peerId: id, version: '0.4.0', networkVersion: 'peach', stars: [process.env.TEST_STAR_URL],
  // No transport URL, kind, or relay secret is configured on the client.
  testHooks: {
    createPeer: ({ kind, peerId }) => {
      if (kind !== 'webrtc') return null
      const peer = Object.assign(new EventEmitter(), {
        peerId, connected: false, initiator: true, channelName: 'unavailable-webrtc',
        signal() {}, send() {}, request: async () => new Uint8Array(),
        destroy() { peer.emit('close') }
      })
      queueMicrotask(() => peer.emit('error', new Error('test forces direct transport unavailable')))
      return peer
    },
    onTransportEvent: event => {
      if (event.type === 'connected') {
        if (event.transport !== 'webtransport') {
          console.error(`expected discovered WebTransport, got ${event.transport}`)
          process.exit(1)
        }
        provedTransport = true
      }
    }
  }
})
const timer = setTimeout(() => { console.error('automatic relay client timed out'); process.exit(1) }, 10_000)
globalThis.pubsub.subscribe('peer:connected', async peerId => {
  if (id !== 'auto-a') return
  try {
    const bytes = await client.getPeer(peerId).request(new Uint8Array([5, 6, 7]), 'auto-test')
    if (!provedTransport || bytes.join(',') !== '8,9') throw new Error('invalid automatic relay response')
    console.log('AUTO_RELAY_PASS')
    await client.close()
    clearTimeout(timer)
    process.exit(0)
  } catch (error) { console.error(error); process.exit(1) }
})
if (id === 'auto-b') globalThis.pubsub.subscribe('auto-test', ({ from }) => {
  client.getPeer(from).send(new Uint8Array([8, 9]), 'auto-test')
})

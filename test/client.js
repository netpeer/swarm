import { Client } from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client('peer-1', 'peach', 1, ['ws://localhost:44444'])

const message = new Uint8Array(64 * 1024)

pubsub.subscribe('peer:connected', (peerId) => {
  console.log('connected' + peerId)
  const peer = client.getPeer(peerId)
  peer.send(message)
})

import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-4',
  networkVersion: 'peach',
  version: 1,
  stars: ['wss://star.leofcoin.org']
})
const message = new Uint8Array(64 * 1024)
pubsub.subscribe('peer:connected', (peerId) => {
  console.log('connected: ' + peerId)
  const peer = client.getPeer(peerId)
  peer.send(message)
})

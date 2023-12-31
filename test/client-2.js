import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-2',
  networkVersion: 'peach',
  version: 1
  // stars: ['ws://localhost:44444']
})
const message = new Uint8Array(64 * 1024)
pubsub.subscribe('hello', () => {
  console.log('ok')
})

pubsub.subscribe('peer:data', (data) => {
  console.log({ data })
})
pubsub.subscribe('peer:connected', (peerId) => {
  console.log('connected: ' + peerId)
  const peer = client.getPeer(peerId)
  console.log(peer.version)
  peer.send(message)
})

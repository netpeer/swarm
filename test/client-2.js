import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-2',
  networkVersion: 'peach',
  version: 1,
  stars: ['ws://localhost:44444']
})
const message = new Uint8Array(64 * 1024)
pubsub.subscribe('hello', (data) => {
  const peer = client.getPeer('peer-1')
  peer.send('hi', 'hello')
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

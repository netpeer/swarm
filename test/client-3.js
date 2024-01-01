import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-3',
  networkVersion: 'peach',
  version: 1,
  stars: ['ws://localhost:44444']
})
pubsub.subscribe('hello', (data) => {
  const peer = client.getPeer('peer-1')
  peer.send('hi', 'hello')
})

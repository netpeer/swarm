import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-1',
  networkVersion: 'peach',
  version: 1,
  stars: ['ws://localhost:44444']
})

const message = new Uint8Array(64 * 1024)

pubsub.subscribe('peer:connected', async (peerId) => {
  console.log('connected: ' + peerId)
  const peer = client.getPeer(peerId)
  await peer.request(message, 'hello')
  await client.close()
  setTimeout(() => {
    client._init()
  }, 10_000)
  // peer.send(message)
})

import Client from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-3',
  networkVersion: 'peach',
  version: 1,
  stars: ['wss://star.leofcoin.org']
})

pubsub.subscribe('data', (peerId) => {
  console.log({ data })
})

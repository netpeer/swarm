import Client from '../exports/browser/client.js'
globalThis.DEBUG = true
const client = new Client({
  peerId: 'peer-5',
  networkVersion: 'peach',
  version: 1,
  stars: ['wss://star.leofcoin.org']
})

pubsub.subscribe('peer:data', (data) => {
  console.log({ data })
})

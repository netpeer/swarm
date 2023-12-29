import { Client } from '../exports/client.js'
globalThis.DEBUG = true
const client = new Client('peer-3', 'peach', 1, ['ws://localhost:44444'])

pubsub.subscribe('data', (peerId) => {
  console.log({ data })
})

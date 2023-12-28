import Client from '../exports/browser/client.js'
globalThis.DEBUG = true
const client = new Client('peer-5', 'peach', 1, ['ws://localhost:44444'])

pubsub.subscribe('peer:data', (data) => {
  console.log({ data })
})

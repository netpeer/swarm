const Client = require('./../dist/commonjs/client');
globalThis.DEBUG = true
const client = new Client()

pubsub.subscribe('peer:connected', (peer) => {
  peer.send('hi')
})

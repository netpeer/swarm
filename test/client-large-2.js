import Client from '../exports/client.js'

const client = new Client({
  peerId: 'peer-large-2',
  networkVersion: 'peach',
  version: 1,
  stars: ['ws://localhost:44444']
})

pubsub.subscribe('peer:data', ({ from, id, data }) => {
  console.log(id)

  if (id === 'big') {
    console.log(`received ${data?.length ?? 'n/a'} bytes from ${from}`)
    const peer = client.getPeer(from)
    // Echo back the same data without allocating a new large buffer
    peer.send(data, 'big')
  }
})

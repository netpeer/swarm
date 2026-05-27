import assert from 'node:assert/strict'
import Client from '../exports/client.js'

class MiniPubSub {
  constructor() {
    this.subscribers = new Map()
  }

  subscribe(topic, handler) {
    const list = this.subscribers.get(topic) || []
    list.push(handler)
    this.subscribers.set(topic, list)
  }

  unsubscribe(topic, handler) {
    const list = this.subscribers.get(topic)
    if (!list) return
    this.subscribers.set(
      topic,
      list.filter((item) => item !== handler)
    )
  }

  hasSubscribers(topic) {
    return (this.subscribers.get(topic) || []).length > 0
  }

  publish(topic, value) {
    const list = this.subscribers.get(topic) || []
    for (const handler of list) handler(value)
  }

  publishVerbose(topic, value) {
    this.publish(topic, value)
  }
}

class FakePeer {
  constructor({ peerId, kind, outcome }) {
    this.connected = false
    this.initiator = true
    this.peerId = peerId
    this.channelName = `${kind}:${peerId}`
    this._destroyed = false
    this._listeners = new Map()

    if (outcome === 'connect') {
      setTimeout(() => {
        if (this._destroyed) return
        this.connected = true
        this._emit('connect')
      }, 0)
    } else if (outcome === 'error') {
      setTimeout(() => {
        if (this._destroyed) return
        this._emit('error', new Error(`${kind} failed`))
      }, 0)
    }
  }

  on(event, handler) {
    const list = this._listeners.get(event) || []
    list.push(handler)
    this._listeners.set(event, list)
    return this
  }

  off(event, handler) {
    const list = this._listeners.get(event) || []
    this._listeners.set(
      event,
      list.filter((item) => item !== handler)
    )
    return this
  }

  signal() {}

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this.connected = false
    this._emit('close')
  }

  send() {}

  request(_data, id = 'fake-id') {
    return Promise.resolve(new TextEncoder().encode(id))
  }

  _emit(event, ...args) {
    const list = this._listeners.get(event) || []
    for (const handler of list) handler(...args)
  }
}

const waitFor = async (predicate, timeoutMs = 1_000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timeout waiting for condition')
}

const createClient = ({
  transport,
  outcomes,
  events,
  connectTimeoutMs = 25
}) => {
  globalThis.pubsub = new MiniPubSub()

  return new Client({
    peerId: 'peer-a',
    networkVersion: 'peach',
    version: 1,
    stars: ['ws://test-star'],
    transport: {
      ...transport,
      fallback: {
        ...(transport.fallback || {}),
        connectTimeoutMs
      }
    },
    testHooks: {
      skipInit: true,
      allowConnectWithoutStar: true,
      onTransportEvent: (event) => events.push(event),
      createPeer: ({ kind, peerId }) => {
        const queue = outcomes[kind] || []
        const outcome = queue.length ? queue.shift() : 'connect'
        return new FakePeer({ peerId, kind, outcome })
      }
    }
  })
}

const testWebTransportFallsBackToWebrtc = async () => {
  const events = []
  const client = createClient({
    transport: {
      kinds: ['webrtc', 'webtransport'],
      preferredKind: 'webtransport',
      webtransport: {
        urlTemplate: 'https://example.test/echo?peer={peerId}&self={selfId}'
      },
      fallback: {
        enabled: false,
        order: ['webtransport', 'webrtc']
      }
    },
    outcomes: {
      webtransport: ['error'],
      webrtc: ['connect']
    },
    events
  })

  client.connect('peer-b', 'test-star', true)

  await waitFor(() =>
    events.some(
      (event) => event.type === 'connected' && event.transport === 'webrtc'
    )
  )

  const sequence = events.map((event) => `${event.type}:${event.transport}`)
  assert.deepEqual(sequence.slice(0, 5), [
    'attempt-started:webtransport',
    'attempt-error:webtransport',
    'attempt-advanced:webtransport',
    'attempt-started:webrtc',
    'connected:webrtc'
  ])

  await client.close()
}

const testCircuitFallbackAfterDirectFailures = async () => {
  const events = []
  const client = createClient({
    transport: {
      kinds: ['webrtc', 'webtransport'],
      preferredKind: 'webtransport',
      webtransport: {
        urlTemplate: 'https://example.test/echo?peer={peerId}&self={selfId}'
      },
      fallback: {
        enabled: true,
        order: ['webtransport', 'webrtc', 'circuit']
      }
    },
    outcomes: {
      webtransport: ['error'],
      webrtc: ['error'],
      circuit: ['connect']
    },
    events
  })

  client.connect('peer-b', 'test-star', true)

  await waitFor(() =>
    events.some(
      (event) => event.type === 'connected' && event.transport === 'circuit'
    )
  )

  const starts = events
    .filter((event) => event.type === 'attempt-started')
    .map((event) => event.transport)
  assert.deepEqual(starts, ['webtransport', 'webrtc', 'circuit'])

  await client.close()
}

const testTimeoutAdvancesToCircuit = async () => {
  const events = []
  const client = createClient({
    transport: {
      kinds: ['webrtc'],
      preferredKind: 'webrtc',
      fallback: {
        enabled: true,
        order: ['webrtc', 'circuit']
      }
    },
    outcomes: {
      webrtc: ['timeout'],
      circuit: ['connect']
    },
    events,
    connectTimeoutMs: 20
  })

  client.connect('peer-b', 'test-star', true)

  await waitFor(() =>
    events.some(
      (event) => event.type === 'connected' && event.transport === 'circuit'
    )
  )

  assert.ok(
    events.some(
      (event) =>
        event.type === 'attempt-timeout' && event.transport === 'webrtc'
    )
  )

  await client.close()
}

const main = async () => {
  await testWebTransportFallsBackToWebrtc()
  await testCircuitFallbackAfterDirectFailures()
  await testTimeoutAdvancesToCircuit()
  console.log('fallback harness passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

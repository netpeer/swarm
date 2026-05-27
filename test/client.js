import Client from '../exports/client.js'
globalThis.DEBUG = true

const transportKinds = (process.env.SWARM_TEST_TRANSPORT_KINDS || '')
  .split(',')
  .map((kind) => kind.trim())
  .filter(Boolean)

const transport =
  transportKinds.length || process.env.SWARM_TEST_TRANSPORT_KIND
    ? {
        ...(process.env.SWARM_TEST_TRANSPORT_KIND
          ? { kind: process.env.SWARM_TEST_TRANSPORT_KIND }
          : {}),
        ...(transportKinds.length ? { kinds: transportKinds } : {}),
        ...(process.env.SWARM_TEST_TRANSPORT_PREFERRED
          ? { preferredKind: process.env.SWARM_TEST_TRANSPORT_PREFERRED }
          : {}),
        webtransport: {
          urlTemplate:
            process.env.SWARM_TEST_WEBTRANSPORT_URL_TEMPLATE ||
            'https://127.0.0.1:65535/echo?peer={peerId}&self={selfId}'
        }
      }
    : undefined

const client = new Client({
  peerId: 'peer-1',
  networkVersion: 'peach',
  version: 1,
  ...(transport ? { transport } : {}),
  stars: [
    process.env.SWARM_TEST_STAR_URL ||
      `ws://localhost:${process.env.SWARM_TEST_PORT || '44444'}`
  ]
})

const message = new Uint8Array(64 * 1024)
const onceMode = process.env.SWARM_TEST_ONCE === '1'
const mode = process.env.SWARM_TEST_MODE || 'peer'
const serverPushValues = new Set()

const exitSuccess = () => {
  setTimeout(async () => {
    await client.close()
    if (onceMode) process.exit(0)
  }, 0)
}

const exitFailure = (message) => {
  setTimeout(async () => {
    if (message) console.error(message)
    await client.close()
    if (onceMode) process.exit(1)
  }, 0)
}

if (onceMode) {
  setTimeout(() => {
    console.error('client test timeout')
    process.exit(1)
  }, 20_000)
}

if (mode === 'circuit') {
  pubsub.subscribe('star:connected', async () => {
    try {
      const response = await client.circuitRequest('peer-2', 'echo', {
        test: 'circuit',
        size: message.length
      })
      if (!response || response.ok !== true) {
        throw new Error('invalid circuit response')
      }
      exitSuccess()
    } catch (error) {
      exitFailure(`circuit request failed: ${error}`)
    }
  })
} else if (mode === 'server-push') {
  const onServerData = (payload) => {
    if (!payload || payload.type !== 'server-push') return
    serverPushValues.add(payload.value)
    if (serverPushValues.has('direct') && serverPushValues.has('broadcast')) {
      exitSuccess()
    }
  }

  client.onServerData(onServerData)
} else if (mode === 'server-request') {
  const onServerData = (payload) => {
    if (!payload || payload.type !== 'server-request-result') return
    if (!payload.ok) {
      exitFailure(`server request failed: ${payload.error}`)
      return
    }
    exitSuccess()
  }

  client.onServerData(onServerData)
} else {
  pubsub.subscribe('peer:connected', async (peerId) => {
    console.log('connected: ' + peerId)
    const peer = client.getPeer(peerId)
    try {
      await peer.request(message, 'hello')
      await client.close()
      if (onceMode) {
        process.exit(0)
        return
      }
      setTimeout(() => {
        client._init()
      }, 10_000)
    } catch (error) {
      console.error('client request failed', error)
      if (onceMode) process.exit(1)
    }
  })
}

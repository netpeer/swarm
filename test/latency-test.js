import Client from '../exports/client.js'

globalThis.DEBUG = true
const client = new Client({
  peerId: 'latency-test-peer',
  networkVersion: 'peach',
  prefix: '/latency-test/',
  version: 1,
  stars: ['ws://localhost:44444']
})

const message = new Uint8Array(64 * 1024)

pubsub.subscribe('peer:connected', async (peerId) => {
  console.log(`\n✓ Connected to: ${peerId}`)

  const peer = client.getPeer(peerId)

  try {
    // Wait a bit for connection to stabilize
    await new Promise((r) => setTimeout(r, 1000))

    // // Test 1: Measure latency via request/response
    // console.log('\n📊 Testing measureLatency()...')
    // const rtt = await peer.measureLatency()
    // console.log(`  Round-trip latency: ${rtt?.toFixed(2)}ms`)

    // Test 2: Get full network stats
    console.log('\n📊 Testing getNetworkStats()...')
    const stats = await peer.getNetworkStats()
    if (stats) {
      console.log(`  ✓ Stats retrieved:`)
      console.log(`    Latency: ${stats.latency}ms`)
      console.log(`    Jitter: ${stats.jitter}ms`)
      console.log(`    Bytes received: ${stats.bytesReceived}`)
      console.log(`    Bytes sent: ${stats.bytesSent}`)
      console.log(`    Packets lost: ${stats.packetsLost}`)
      console.log(`    Fraction lost: ${stats.fractionLost}`)
      console.log(
        `    Available outgoing bitrate: ${stats.availableOutgoingBitrate}`
      )
    } else {
      console.log(
        '  ⚠️ Stats not available yet (connection may not be fully established)'
      )
    }

    // Test 3: Check serialization
    console.log('\n📊 Testing toJSON()...')
    const json = peer.toJSON()
    console.log(`  Peer JSON:`, JSON.stringify(json, null, 2))

    // Close after tests
    console.log('\n✓ All tests completed successfully!\n')
    await client.close()
    process.exit(0)
  } catch (err) {
    console.error('Error during testing:', err.message)
    process.exit(1)
  }
})

// Timeout after 30 seconds
setTimeout(() => {
  console.error('Test timeout - no connection established')
  process.exit(1)
}, 30000)

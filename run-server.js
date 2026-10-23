import { startHostedStar } from './hosted-star.js'

const runtime = await startHostedStar()
let stopping = false
const stop = async () => { stopping = true; await runtime.stop() }
if (runtime.relay) console.log(`WebTransport relay ready: ${runtime.relay.url}`)
else console.warn('WebTransport hosting unavailable: no public TLS domain found; WebRTC and circuit remain available')
const unexpectedRelayStop = async () => {
  if (stopping) return
  console.error('WebTransport relay stopped unexpectedly')
  process.exitCode = 1
  await stop()
}
if (runtime.relay) void runtime.relay.closed.then(unexpectedRelayStop, unexpectedRelayStop)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })

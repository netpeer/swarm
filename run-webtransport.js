// Advanced standalone mode; public hosting normally uses a single `npm start`.
import { loadRelaySecret } from './relay-config.js'
import { hostedRelayConfig } from './hosted-star.js'
import { startRelay } from './relay-service.js'

const { path, secret } = loadRelaySecret()
const config = hostedRelayConfig(process.env, path)
if (!config) throw new Error('no public TLS domain found for standalone relay')
const relay = await startRelay(config, secret)
console.log(`WebTransport relay ready: ${relay.url}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, relay.stop)
await relay.closed

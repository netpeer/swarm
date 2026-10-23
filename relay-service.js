import { randomBytes, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { loadRelayTls } from './relay-config.js'
import { WebTransportRelay } from './exports/webtransport-relay.js'

export const startRelay = async (env, secret) => {
  const tls = loadRelayTls(env)
  const hostname = env.SWARM_WT_HOSTNAME
  const certificate = new X509Certificate(tls.cert)
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error('WebTransport TLS certificate is not currently valid')
  }
  if (!hostname || !(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))) {
    throw new Error('WebTransport requires a public hostname matching its TLS certificate')
  }
  const { Http3Server, quicheLoaded } = await import('@fails-components/webtransport')
  await quicheLoaded
  const relay = new WebTransportRelay({ secret })
  const server = new Http3Server({
    host: env.SWARM_WT_HOST || '0.0.0.0', port: Number(env.SWARM_WT_PORT || 4433),
    secret: randomBytes(32).toString('hex'), ...tls
  })
  const reader = server.sessionStream('/swarm').getReader()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    relay.close()
    void reader.cancel().catch(() => {})
    server.stopServer()
  }
  try {
    server.startServer()
    let timer
    try {
      await Promise.race([server.ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WebTransport server startup timed out')), 10_000)
      })])
    } finally { clearTimeout(timer) }
  } catch (error) { stop(); throw error }
  const closed = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) break
        void relay.accept(value)
      }
    } finally { stop() }
  })()
  void closed.catch(() => {})
  void server.closed.then(stop, stop)
  return { url: `https://${hostname}:${server.address().port}/swarm`, stop, closed }
}

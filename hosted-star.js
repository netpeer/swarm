import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, linkSync, unlinkSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import Server from './exports/server.js'
import { loadRelaySecret } from './relay-config.js'
import { startRelay } from './relay-service.js'

export const hostedRelayConfig = (env, secretPath, certificateRoot = '/etc/letsencrypt/live') => {
  const configPath = join(dirname(secretPath), 'relay-settings.json')
  const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const keys = ['SWARM_WT_HOSTNAME', 'SWARM_WT_CERT_FILE', 'SWARM_WT_KEY_FILE', 'SWARM_WT_HOST', 'SWARM_WT_PORT']
  const config = { ...env }
  for (const key of keys) if (!config[key] && saved[key]) config[key] = saved[key]
  if (!config.SWARM_WT_HOSTNAME && existsSync(certificateRoot)) {
    const candidates = readdirSync(certificateRoot).filter(name => {
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) return false
      try {
        const cert = new X509Certificate(readFileSync(join(certificateRoot, name, 'fullchain.pem')))
        return cert.checkHost(name) && Date.parse(cert.validTo) > Date.now() &&
          Date.parse(cert.validFrom) <= Date.now() && existsSync(join(certificateRoot, name, 'privkey.pem'))
      } catch { return false }
    })
    if (candidates.length === 1) {
      config.SWARM_WT_HOSTNAME = candidates[0]
      config.SWARM_WT_CERT_FILE = join(certificateRoot, candidates[0], 'fullchain.pem')
      config.SWARM_WT_KEY_FILE = join(certificateRoot, candidates[0], 'privkey.pem')
    } else if (candidates.length > 1) {
      throw new Error('multiple public TLS domains found; set SWARM_WT_HOSTNAME once to select the relay domain')
    }
  }
  if (!config.SWARM_WT_HOSTNAME) {
    if (config.SWARM_WT_CERT_FILE || config.SWARM_WT_KEY_FILE) throw new Error('SWARM_WT_HOSTNAME is required with custom TLS files')
    return null
  }
  return config
}

const persistConfig = (config, secretPath) => {
  const path = join(dirname(secretPath), 'relay-settings.json')
  if (existsSync(path)) return
  const keys = ['SWARM_WT_HOSTNAME', 'SWARM_WT_CERT_FILE', 'SWARM_WT_KEY_FILE', 'SWARM_WT_HOST', 'SWARM_WT_PORT']
  const settings = Object.fromEntries(keys.filter(key => config[key]).map(key => [key, config[key]]))
  const temporary = mkdtempSync(join(dirname(secretPath), '.relay-settings-'))
  const candidate = join(temporary, 'settings')
  try {
    // Publish only complete, validated settings; never overwrite user config.
    writeFileSync(candidate, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    try { linkSync(candidate, path) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { if (existsSync(candidate)) unlinkSync(candidate); rmdirSync(temporary) }
}

export const startHostedStar = async (env = process.env) => {
  const { path, secret } = loadRelaySecret(env)
  const config = hostedRelayConfig(env, path)
  // Advertise only after the native QUIC server is actually listening.
  const relay = config ? await startRelay(config, secret) : null
  let star
  try {
    star = new Server(Number(env.SWARM_PORT || 44444), env.SWARM_NETWORK || 'peach', {
      relaySecret: secret, relayUrl: relay?.url
    })
    await star.ready
    if (config) persistConfig(config, path)
  } catch (error) { relay?.stop(); await star?.close(); throw error }
  const stop = async () => { relay?.stop(); await star.close() }
  return { star, relay, stop }
}

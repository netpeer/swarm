import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { startHostedStar, hostedRelayConfig } from '../hosted-star.js'
import { loadRelaySecret } from '../relay-config.js'

test('one hosted start serves real HTTP3, default clients discover it, settings survive restart', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-auto-relay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const certPath = join(root, 'cert.pem'), keyPath = join(root, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:other.local,IP:127.0.0.1'], { stdio: 'pipe' })
  const discoveryPath = loadRelaySecret({ SWARM_DATA_DIR: join(root, 'discovery') }).path
  const live = join(root, 'live')
  mkdirSync(join(live, 'localhost'), { recursive: true })
  copyFileSync(certPath, join(live, 'localhost', 'fullchain.pem'))
  copyFileSync(keyPath, join(live, 'localhost', 'privkey.pem'))
  assert.equal(hostedRelayConfig({}, discoveryPath, live).SWARM_WT_HOSTNAME, 'localhost')
  mkdirSync(join(live, 'other.local'))
  copyFileSync(certPath, join(live, 'other.local', 'fullchain.pem'))
  copyFileSync(keyPath, join(live, 'other.local', 'privkey.pem'))
  assert.throws(() => hostedRelayConfig({}, discoveryPath, live), /multiple public TLS domains/)
  const badRoot = join(root, 'bad-start')
  await assert.rejects(startHostedStar({ SWARM_DATA_DIR: badRoot, SWARM_WT_HOSTNAME: 'localhost', SWARM_WT_CERT_FILE: join(root, 'missing.pem'), SWARM_WT_KEY_FILE: keyPath }), /ENOENT/)
  assert.equal(existsSync(join(badRoot, 'network-peach', 'relay-settings.json')), false)
  const cert = new X509Certificate(readFileSync(certPath))
  const env = { SWARM_DATA_DIR: root, SWARM_PORT: '0', SWARM_WT_HOSTNAME: '127.0.0.1', SWARM_WT_CERT_FILE: certPath, SWARM_WT_KEY_FILE: keyPath, SWARM_WT_HOST: '127.0.0.1', SWARM_WT_PORT: '0' }
  const runtime = await startHostedStar(env)
  const children = []
  t.after(async () => { for (const child of children) child.kill(); await runtime.stop() })
  assert.ok(runtime.relay.url.startsWith('https://127.0.0.1:'))
  const firstSecret = loadRelaySecret(env).secret
  const config = hostedRelayConfig({ SWARM_DATA_DIR: root }, loadRelaySecret(env).path, join(root, 'missing-certs'))
  assert.equal(config.SWARM_WT_HOSTNAME, '127.0.0.1')
  const clientEnv = {
    ...process.env, TEST_STAR_URL: `ws://127.0.0.1:${runtime.star.address().port}`,
    TEST_CERT_HASH: JSON.stringify([...Buffer.from(cert.fingerprint256.replaceAll(':', ''), 'hex')])
  }
  const spawnClient = id => {
    const child = spawn(process.execPath, ['test/auto-relay-client.js'], { env: { ...clientEnv, TEST_PEER_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    return new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', code => code === 0 && output.includes('AUTO_RELAY_PASS') ? resolve(output) : reject(new Error(output)))
    })
  }
  // The responder stays running until cleanup; avoid an unhandled rejected
  // promise when its intentionally terminated child exits.
  void spawnClient('auto-b').catch(() => {})
  const result = await spawnClient('auto-a')
  assert.match(result, /AUTO_RELAY_PASS/)
  await runtime.stop()
  const restarted = await startHostedStar({ SWARM_DATA_DIR: root, SWARM_PORT: '0' })
  try {
    assert.ok(restarted.relay)
    assert.equal(loadRelaySecret(env).secret, firstSecret)
    assert.deepEqual(readdirSync(join(root, 'network-peach')).sort(), ['relay-secret', 'relay-settings.json'])
  } finally { await restarted.stop() }
  // Exercise the actual single-command entry point on the next start. TLS
  // flags and secrets are absent; it must load the persisted settings itself.
  const entryEnv = { ...process.env, SWARM_DATA_DIR: root, SWARM_PORT: '0' }
  for (const key of ['SWARM_WT_HOSTNAME', 'SWARM_WT_CERT_FILE', 'SWARM_WT_KEY_FILE', 'SWARM_WT_PORT', 'SWARM_WT_HOST', 'SWARM_RELAY_SECRET_FILE']) delete entryEnv[key]
  const entry = spawn(process.execPath, ['run-server.js'], { env: entryEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(entry)
  let entryOutput = ''
  await new Promise((resolve, reject) => {
    entry.stdout.on('data', data => {
      entryOutput += data
      if (entryOutput.includes('WebTransport relay ready:')) resolve()
    })
    entry.stderr.on('data', data => { entryOutput += data })
    entry.on('error', reject)
    entry.on('exit', () => reject(new Error(`single-command startup failed: ${entryOutput}`)))
  })
  const exited = new Promise(resolve => entry.once('exit', resolve))
  entry.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.ok(!entryOutput.includes(firstSecret))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadRelaySecret, relaySecretPath, loadRelayTls } from '../relay-config.js'

const temporary = t => {
  const path = mkdtempSync(join(tmpdir(), 'swarm-config-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('first start creates private directories and a persistent random secret', t => {
  const home = temporary(t)
  const first = loadRelaySecret({}, home)
  assert.equal(first.path, join(home, '.netpeer', 'swarm', 'network-peach', 'relay-secret'))
  assert.match(first.secret, /^[0-9a-f]{64}$/)
  assert.deepEqual(loadRelaySecret({}, home), first)
  if (process.platform !== 'win32') {
    assert.equal(statSync(first.path).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.netpeer', 'swarm', 'network-peach')).mode & 0o777, 0o700)
  }
})

test('star and relay processes starting concurrently reuse one complete secret', async t => {
  const root = temporary(t)
  const env = { SWARM_DATA_DIR: root, SWARM_NETWORK: 'peach' }
  const source = `import {createHash} from 'node:crypto'; import {loadRelaySecret} from ${JSON.stringify(new URL('../relay-config.js', import.meta.url).href)}; const {secret} = loadRelaySecret(${JSON.stringify(env)}); console.log(createHash('sha256').update(secret).digest('hex'));`
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])))
  assert.equal(new Set(results.map(result => result.stdout.trim())).size, 1)
  assert.match(loadRelaySecret(env).secret, /^[0-9a-f]{64}$/)
  assert.deepEqual(readdirSync(join(root, 'network-peach')), ['relay-secret'])
})

test('default path is independent of cwd and separates networks without path traversal', t => {
  const home = temporary(t)
  const a = loadRelaySecret({ SWARM_NETWORK: 'leofcoin:peach' }, home)
  const b = loadRelaySecret({ SWARM_NETWORK: '../other/network' }, home)
  assert.notEqual(a.secret, b.secret)
  assert.equal(b.path, join(home, '.netpeer', 'swarm', 'network-..%2Fother%2Fnetwork', 'relay-secret'))
  assert.equal(relaySecretPath({}, home), join(home, '.netpeer', 'swarm', 'network-peach', 'relay-secret'))
})

test('explicit secret file is created automatically and existing valid secrets remain unchanged', t => {
  const path = join(temporary(t), 'custom', 'relay-secret')
  const env = { SWARM_RELAY_SECRET_FILE: path }
  loadRelaySecret(env)
  const existing = 'existing-private-relay-secret-at-least-32-bytes\n'
  writeFileSync(path, existing, { mode: 0o600 })
  assert.equal(loadRelaySecret(env).secret, existing.trim())
  assert.equal(readFileSync(path, 'utf8'), existing)
})

test('empty and invalid existing secrets fail without replacement or leakage', t => {
  const path = join(temporary(t), 'secret')
  for (const contents of ['', 'too-short', 'x'.repeat(4097)]) {
    writeFileSync(path, contents, { mode: 0o600 })
    assert.throws(() => loadRelaySecret({ SWARM_RELAY_SECRET_FILE: path }), /invalid relay secret|at least 32 bytes/)
    assert.equal(readFileSync(path, 'utf8'), contents)
  }
})

test('unsafe permissions and symlinks are rejected instead of rotated', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t)
  const path = join(root, 'secret')
  writeFileSync(path, 'private-existing-relay-secret-at-least-32-bytes', { mode: 0o600 })
  chmodSync(path, 0o644)
  assert.throws(() => loadRelaySecret({ SWARM_RELAY_SECRET_FILE: path }), /must be private/)
  chmodSync(path, 0o600)
  const link = join(root, 'link')
  symlinkSync(path, link)
  assert.throws(() => loadRelaySecret({ SWARM_RELAY_SECRET_FILE: link }))
  assert.equal(readFileSync(path, 'utf8'), 'private-existing-relay-secret-at-least-32-bytes')
})

test('TLS uses explicit certificate files and never invents a production certificate', t => {
  const root = temporary(t)
  const cert = join(root, 'cert.pem'), key = join(root, 'key.pem')
  writeFileSync(cert, 'certificate fixture')
  writeFileSync(key, 'key fixture')
  assert.deepEqual(loadRelayTls({ SWARM_WT_CERT_FILE: cert, SWARM_WT_KEY_FILE: key }), { cert: 'certificate fixture', privKey: 'key fixture' })
  assert.throws(() => loadRelayTls({}), /SWARM_WT_HOSTNAME/)
  assert.throws(() => loadRelayTls({ SWARM_WT_HOSTNAME: '../invalid' }), /invalid SWARM_WT_HOSTNAME/)
})

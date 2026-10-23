import {
  constants, openSync, closeSync, fstatSync, readFileSync, mkdirSync,
  mkdtempSync, writeFileSync, fsyncSync, linkSync, unlinkSync, rmdirSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const relaySecretPath = (env = process.env, home = homedir()) => {
  if (env.SWARM_RELAY_SECRET_FILE) return resolve(env.SWARM_RELAY_SECRET_FILE)
  const network = env.SWARM_NETWORK || 'peach'
  if (network.length > 128 || network.includes('\0')) throw new Error('invalid SWARM_NETWORK')
  return join(resolve(env.SWARM_DATA_DIR || join(home, '.netpeer', 'swarm')),
    `network-${encodeURIComponent(network)}`, 'relay-secret')
}

const readSecret = path => {
  // Never follow a secret-file symlink or read an arbitrary special file.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 4096) throw new Error(`invalid relay secret file: ${path}`)
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error(`relay secret file must belong to the service account: ${path}`)
    }
    if (process.platform !== 'win32' && (info.mode & 0o077)) {
      throw new Error(`relay secret file must be private (chmod 600): ${path}`)
    }
    const secret = readFileSync(fd, 'utf8').trim()
    if (Buffer.byteLength(secret) < 32) throw new Error(`relay secret must contain at least 32 bytes: ${path}`)
    return secret
  } finally { closeSync(fd) }
}

export const loadRelaySecret = (env = process.env, home = homedir()) => {
  const path = relaySecretPath(env, home)
  try { return { path, secret: readSecret(path) } }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  // Publish a fully written secret atomically, without replacing another
  // process's file. Opening the final path with 'wx' before writing would let
  // the other service observe an empty or partially written secret.
  const temporary = mkdtempSync(join(parent, '.relay-secret-'))
  const candidate = join(temporary, 'secret')
  try {
    writeFileSync(candidate, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
    const fd = openSync(candidate, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(candidate, path) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally {
    try { unlinkSync(candidate) } catch (error) { if (error.code !== 'ENOENT') throw error }
    rmdirSync(temporary)
  }
  return { path, secret: readSecret(path) }
}

export const loadRelayTls = (env = process.env) => {
  const hostname = env.SWARM_WT_HOSTNAME
  if (hostname && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) {
    throw new Error('invalid SWARM_WT_HOSTNAME')
  }
  const certPath = env.SWARM_WT_CERT_FILE || (hostname && `/etc/letsencrypt/live/${hostname}/fullchain.pem`)
  const keyPath = env.SWARM_WT_KEY_FILE || (hostname && `/etc/letsencrypt/live/${hostname}/privkey.pem`)
  if (!certPath || !keyPath) {
    throw new Error('set SWARM_WT_HOSTNAME to use existing Lets Encrypt certificates, or set SWARM_WT_CERT_FILE and SWARM_WT_KEY_FILE')
  }
  return { cert: readFileSync(certPath, 'utf8'), privKey: readFileSync(keyPath, 'utf8') }
}

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Http2Server, WebTransport } from '@fails-components/webtransport'

const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 3)
const PAYLOAD_BYTES = Number(process.env.BENCH_PAYLOAD_BYTES || 65536)
const MESSAGES = Number(process.env.BENCH_MESSAGES || 100)
const CONNECT_TIMEOUT_MS = Number(process.env.BENCH_CONNECT_TIMEOUT_MS || 8000)
const SEND_TIMEOUT_MS = Number(process.env.BENCH_SEND_TIMEOUT_MS || 30000)
const WEBTRANSPORT_URL = process.env.BENCH_WEBTRANSPORT_URL || ''
const USE_LOCAL =
  !WEBTRANSPORT_URL &&
  String(process.env.BENCH_WEBTRANSPORT_LOCAL || '1').toLowerCase() !== '0'
const LOCAL_HOST = process.env.BENCH_WEBTRANSPORT_HOST || '127.0.0.1'
const LOCAL_PATH = process.env.BENCH_WEBTRANSPORT_PATH || '/echo'

const percentile = (arr, p) => {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  )
  return sorted[Math.max(0, idx)]
}

const createSelfSignedCertificate = () => {
  const certDir = mkdtempSync(join(tmpdir(), 'swarm-wt-'))
  const keyPath = join(certDir, 'key.pem')
  const certPath = join(certDir, 'cert.pem')

  const runOpenSsl = (args) =>
    spawnSync('openssl', args, {
      stdio: 'pipe',
      encoding: 'utf8'
    })

  let certResult = runOpenSsl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-sha256',
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])

  if (certResult.status !== 0) {
    certResult = runOpenSsl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-sha256',
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1'
    ])
  }

  if (certResult.status !== 0) {
    throw new Error(
      `openssl cert generation failed: ${certResult.stderr || certResult.stdout}`
    )
  }

  const fpResult = runOpenSsl([
    'x509',
    '-in',
    certPath,
    '-noout',
    '-fingerprint',
    '-sha256'
  ])

  if (fpResult.status !== 0) {
    throw new Error(
      `openssl fingerprint failed: ${fpResult.stderr || fpResult.stdout}`
    )
  }

  const raw = String(fpResult.stdout || '').trim()
  const match = raw.match(/Fingerprint=([A-Fa-f0-9:]+)/)
  if (!match?.[1]) {
    throw new Error(`unexpected fingerprint output: ${raw}`)
  }

  const hashBytes = Buffer.from(
    match[1]
      .split(':')
      .map((part) => parseInt(part, 16))
      .filter((value) => Number.isFinite(value))
  )

  return {
    certDir,
    cert: readFileSync(certPath, 'utf8'),
    privKey: readFileSync(keyPath, 'utf8'),
    hashBytes
  }
}

const startEchoSessionLoop = async (server, path) => {
  const sessionStream = await server.sessionStream(path)
  const reader = sessionStream.getReader()

  const pumpSession = async (session) => {
    await session.ready

    const incoming = session.incomingBidirectionalStreams.getReader()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await incoming.read()
        if (done) break
        if (!value) continue
        // eslint-disable-next-line no-await-in-loop
        await value.readable.pipeTo(value.writable)
      }
    } catch (e) {
      // session closed
    }
  }

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    void pumpSession(value)
  }
}

const startLocalServer = async () => {
  const certBundle = createSelfSignedCertificate()
  const server = new Http2Server({
    host: LOCAL_HOST,
    port: 0,
    secret: randomBytes(16).toString('hex'),
    cert: certBundle.cert,
    privKey: certBundle.privKey
  })

  const loopPromise = startEchoSessionLoop(server, LOCAL_PATH)
  server.startServer()
  await withTimeout(server.ready, CONNECT_TIMEOUT_MS, 'local-server-ready')

  const address = server.address()
  if (!address?.port) {
    throw new Error('local WebTransport server failed to bind')
  }

  const stop = async () => {
    try {
      server.stopServer()
    } catch (e) {}
    try {
      await server.closed
    } catch (e) {}
    try {
      rmSync(certBundle.certDir, { recursive: true, force: true })
    } catch (e) {}
  }

  return {
    url: `https://${LOCAL_HOST}:${address.port}${LOCAL_PATH}`,
    certificateHashes: [
      {
        algorithm: 'sha-256',
        value: certBundle.hashBytes
      }
    ],
    stop,
    loopPromise
  }
}

const parseExternalCertHash = () => {
  const raw = (process.env.BENCH_WEBTRANSPORT_CERT_SHA256 || '').trim()
  if (!raw) return undefined
  const normalized = raw.replace(/^sha-256:/i, '').replace(/\s+/g, '')
  const coloned = normalized.includes(':')
    ? normalized
    : normalized.match(/.{1,2}/g)?.join(':') || normalized
  const bytes = Buffer.from(
    coloned
      .split(':')
      .map((part) => parseInt(part, 16))
      .filter((value) => Number.isFinite(value))
  )
  if (bytes.length !== 32) {
    throw new Error('BENCH_WEBTRANSPORT_CERT_SHA256 must be a SHA-256 hex hash')
  }
  return [{ algorithm: 'sha-256', value: bytes }]
}

const withTimeout = async (promise, timeoutMs, label) => {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label}-timeout`))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

const runIteration = async ({ url, certificateHashes }) => {
  const payload = new Uint8Array(PAYLOAD_BYTES)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251

  const start = Date.now()

  const session = new WebTransport(url, {
    forceReliable: true,
    serverCertificateHashes: certificateHashes
  })
  await withTimeout(session.ready, CONNECT_TIMEOUT_MS, 'connect')

  const stream = await withTimeout(
    session.createBidirectionalStream(),
    CONNECT_TIMEOUT_MS,
    'stream-open'
  )

  const reader = stream.readable.getReader()
  const writer = stream.writable.getWriter()

  let receivedBytes = 0
  const expectedBytes = MESSAGES * PAYLOAD_BYTES
  const connectMs = Date.now() - start
  const sendStart = Date.now()

  const readTask = (async () => {
    while (receivedBytes < expectedBytes) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      receivedBytes += value.byteLength || value.length || 0
    }
  })()

  const writeTask = (async () => {
    for (let i = 0; i < MESSAGES; i++) {
      // eslint-disable-next-line no-await-in-loop
      await writer.ready
      // eslint-disable-next-line no-await-in-loop
      await writer.write(payload)
    }
  })()

  try {
    await withTimeout(
      Promise.all([writeTask, readTask]),
      SEND_TIMEOUT_MS,
      'send'
    )
  } finally {
    try {
      await writer.close()
    } catch (e) {}
    writer.releaseLock()
    try {
      await reader.cancel()
    } catch (e) {}
    reader.releaseLock()
    try {
      session.close()
    } catch (e) {}
  }

  if (receivedBytes < expectedBytes) {
    throw new Error(
      `incomplete-echo: received=${receivedBytes}, expected=${expectedBytes}`
    )
  }

  const sendMs = Date.now() - sendStart
  const bytesPerSecond = (receivedBytes / sendMs) * 1000
  const mibPerSecond = bytesPerSecond / (1024 * 1024)

  return {
    ok: true,
    connectMs,
    sendMs,
    mibPerSecond
  }
}

const main = async () => {
  let targetUrl = WEBTRANSPORT_URL
  let certificateHashes = parseExternalCertHash()
  let localStop = null
  let localLoopPromise = null

  if (USE_LOCAL) {
    const local = await startLocalServer()
    targetUrl = local.url
    certificateHashes = local.certificateHashes
    localStop = local.stop
    localLoopPromise = local.loopPromise
  }

  if (!targetUrl) {
    console.log(
      'Skipping WebTransport benchmark: set BENCH_WEBTRANSPORT_URL or enable BENCH_WEBTRANSPORT_LOCAL=1'
    )
    process.exit(0)
  }

  console.log(
    `Running WebTransport benchmark with iterations=${ITERATIONS}, messages=${MESSAGES}, payloadBytes=${PAYLOAD_BYTES}, connectTimeoutMs=${CONNECT_TIMEOUT_MS}, sendTimeoutMs=${SEND_TIMEOUT_MS}`
  )
  console.log(`Target: ${targetUrl}`)

  const results = []
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await runIteration({
          url: targetUrl,
          certificateHashes
        })
        results.push(result)
      } catch (error) {
        results.push({ ok: false, reason: error?.message || String(error) })
      }
    }
  } finally {
    if (localStop) await localStop()
    void localLoopPromise
  }

  const successes = results.filter((r) => r.ok)
  const failures = results.filter((r) => !r.ok)

  const connectTimes = successes.map((r) => r.connectMs)
  const throughputs = successes.map((r) => r.mibPerSecond)

  console.log('\nBenchmark Results')
  console.log(`  success: ${successes.length}/${ITERATIONS}`)
  console.log(
    `  connect avg ms: ${
      connectTimes.length
        ? Math.round(
            connectTimes.reduce((a, b) => a + b, 0) / connectTimes.length
          )
        : 'n/a'
    }`
  )
  console.log(`  connect p95 ms: ${percentile(connectTimes, 95) ?? 'n/a'}`)
  console.log(
    `  throughput avg MiB/s: ${
      throughputs.length
        ? Number(
            (
              throughputs.reduce((a, b) => a + b, 0) / throughputs.length
            ).toFixed(2)
          )
        : 'n/a'
    }`
  )
  console.log(
    `  throughput p95 MiB/s: ${
      throughputs.length
        ? Number((percentile(throughputs, 95) || 0).toFixed(2))
        : 'n/a'
    }`
  )
  if (failures.length) {
    console.log(`  failures: ${failures.map((f) => f.reason).join(' | ')}`)
  }

  process.exit(0)
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exit(1)
})

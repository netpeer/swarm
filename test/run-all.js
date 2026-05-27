import { spawn } from 'child_process'

const TIMEOUT_MS = 30_000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const terminate = async (proc) => {
  if (!proc || proc.exitCode !== null || proc.killed) return
  proc.kill('SIGTERM')
  await wait(500)
  if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
}

const runCommand = (label, command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    })

    child.stdout.on('data', (chunk) => {
      process.stdout.write(`[${label}] ${chunk}`)
    })

    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[${label}] ${chunk}`)
    })

    const timeout = options.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`${label} timed out after ${options.timeout}ms`))
        }, options.timeout)
      : null

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with exit code ${code}`))
    })
  })

const runIntegration = async (scenarioEnv = {}) => {
  const port = process.env.SWARM_TEST_PORT || '45454'
  const env = {
    ...process.env,
    SWARM_TEST_ONCE: '1',
    SWARM_TEST_PORT: port,
    SWARM_TEST_STAR_URL:
      process.env.SWARM_TEST_STAR_URL || `ws://localhost:${port}`,
    ...scenarioEnv
  }
  const server = spawn(process.execPath, ['./test/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })
  const client2 = spawn(process.execPath, ['./test/client-2.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })

  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`))
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))
  client2.stdout.on('data', (chunk) =>
    process.stdout.write(`[client-2] ${chunk}`)
  )
  client2.stderr.on('data', (chunk) =>
    process.stderr.write(`[client-2] ${chunk}`)
  )

  let serverExitCode = null
  server.on('exit', (code) => {
    serverExitCode = code
  })

  await wait(750)

  if (serverExitCode !== null && serverExitCode !== 0) {
    throw new Error(
      `integration server failed with exit code ${serverExitCode}`
    )
  }

  try {
    await runCommand('client-1', process.execPath, ['./test/client.js'], {
      env,
      timeout: TIMEOUT_MS
    })
  } finally {
    await terminate(client2)
    await terminate(server)
  }
}

const main = async () => {
  const integrationOnly = process.argv.includes('--integration-only')
  if (!integrationOnly) {
    await runCommand('build', 'npm', ['run', 'build'])
    await runCommand('unit-latency', process.execPath, [
      './test/unit-latency.js'
    ])
    await runCommand('fallback-harness', process.execPath, [
      './test/fallback-harness.js'
    ])
  }
  await runIntegration({ SWARM_TEST_MODE: 'peer' })
  await runIntegration({
    SWARM_TEST_MODE: 'circuit',
    SWARM_TEST_TRANSPORT_KINDS: 'webrtc',
    SWARM_TEST_TRANSPORT_PREFERRED: 'webrtc',
    SWARM_TEST_TRANSPORT_KINDS_PEER2: 'webtransport',
    SWARM_TEST_TRANSPORT_PREFERRED_PEER2: 'webtransport'
  })
  await runIntegration({
    SWARM_TEST_MODE: 'circuit',
    SWARM_TEST_TRANSPORT_KINDS: 'webrtc,webtransport',
    SWARM_TEST_TRANSPORT_PREFERRED: 'webrtc',
    SWARM_TEST_TRANSPORT_KINDS_PEER2: 'webrtc,webtransport',
    SWARM_TEST_TRANSPORT_PREFERRED_PEER2: 'webtransport'
  })
  await runIntegration({
    SWARM_TEST_MODE: 'server-push',
    SWARM_TEST_SERVER_MODE: 'push',
    SWARM_TEST_TRANSPORT_KINDS: 'webrtc,webtransport',
    SWARM_TEST_TRANSPORT_KINDS_PEER2: 'webrtc,webtransport'
  })
  await runIntegration({
    SWARM_TEST_MODE: 'server-request',
    SWARM_TEST_SERVER_MODE: 'request',
    SWARM_TEST_TRANSPORT_KINDS: 'webrtc,webtransport',
    SWARM_TEST_TRANSPORT_KINDS_PEER2: 'webrtc,webtransport'
  })
  console.log('All tests passed')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

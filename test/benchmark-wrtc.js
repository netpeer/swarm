const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 5)
const PAYLOAD_BYTES = Number(process.env.BENCH_PAYLOAD_BYTES || 262144)
const MESSAGES = Number(process.env.BENCH_MESSAGES || 100)
const CONNECT_TIMEOUT_MS = Number(process.env.BENCH_CONNECT_TIMEOUT_MS || 8000)
const DEFAULT_SEND_TIMEOUT_MS = Math.max(
  30000,
  Math.ceil(((MESSAGES * PAYLOAD_BYTES) / (4 * 1024 * 1024)) * 1000) + 5000
)
const SEND_TIMEOUT_MS = Number(
  process.env.BENCH_SEND_TIMEOUT_MS || DEFAULT_SEND_TIMEOUT_MS
)

const getImplementation = async (name) => {
  if (name === 'koush') {
    const mod = await import('@koush/wrtc')
    return mod.default
  }

  throw new Error(`unknown backend: ${name}`)
}

const isValidWrtc = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return false
  return (
    typeof candidate.RTCPeerConnection === 'function' &&
    typeof candidate.RTCSessionDescription === 'function' &&
    typeof candidate.RTCIceCandidate === 'function'
  )
}

const percentile = (arr, p) => {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  )
  return sorted[Math.max(0, idx)]
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const runIteration = async (wrtc) => {
  const payload = new Uint8Array(PAYLOAD_BYTES)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251

  const start = Date.now()

  return await new Promise((resolve) => {
    const pc1 = new wrtc.RTCPeerConnection({ iceServers: [] })
    const pc2 = new wrtc.RTCPeerConnection({ iceServers: [] })
    const dc1 = pc1.createDataChannel('bench')
    let dc2
    let done = false

    let receivedMessages = 0
    let receivedBytes = 0
    let sendStart = 0
    let connectTimeout
    let sendTimeout
    const pendingOnPc1 = []
    const pendingOnPc2 = []

    const flushCandidates = async (pc, pending) => {
      if (!pc.remoteDescription) return
      while (pending.length) {
        const candidate = pending.shift()
        if (!candidate) continue
        try {
          // eslint-disable-next-line no-await-in-loop
          await pc.addIceCandidate(candidate)
        } catch (error) {
          finish({ ok: false, reason: `ice: ${error?.message || error}` })
          return
        }
      }
    }

    const cleanup = () => {
      try {
        dc1.close()
      } catch (e) {}
      try {
        dc2?.close()
      } catch (e) {}
      try {
        pc1.close()
      } catch (e) {}
      try {
        pc2.close()
      } catch (e) {}
    }

    const finish = (result) => {
      if (done) return
      done = true
      if (connectTimeout) clearTimeout(connectTimeout)
      if (sendTimeout) clearTimeout(sendTimeout)
      cleanup()
      resolve(result)
    }

    connectTimeout = setTimeout(() => {
      finish({ ok: false, reason: 'connect-timeout' })
    }, CONNECT_TIMEOUT_MS)

    pc1.onicecandidate = (event) => {
      const candidate = event.candidate
      if (!candidate) return
      if (pc2.remoteDescription) {
        void pc2.addIceCandidate(candidate).catch((error) => {
          finish({ ok: false, reason: `ice-pc2: ${error?.message || error}` })
        })
        return
      }
      pendingOnPc2.push(candidate)
    }

    pc2.onicecandidate = (event) => {
      const candidate = event.candidate
      if (!candidate) return
      if (pc1.remoteDescription) {
        void pc1.addIceCandidate(candidate).catch((error) => {
          finish({ ok: false, reason: `ice-pc1: ${error?.message || error}` })
        })
        return
      }
      pendingOnPc1.push(candidate)
    }

    dc1.onerror = (event) => {
      finish({ ok: false, reason: `dc1: ${event?.message || 'error'}` })
    }

    pc1.onconnectionstatechange = () => {
      if (
        pc1.connectionState === 'failed' ||
        pc1.connectionState === 'closed'
      ) {
        finish({ ok: false, reason: `pc1: ${pc1.connectionState}` })
      }
    }

    pc2.onconnectionstatechange = () => {
      if (
        pc2.connectionState === 'failed' ||
        pc2.connectionState === 'closed'
      ) {
        finish({ ok: false, reason: `pc2: ${pc2.connectionState}` })
      }
    }

    const onIncomingChunk = (chunk) => {
      const bytes =
        chunk instanceof ArrayBuffer
          ? chunk.byteLength
          : (chunk?.byteLength ?? chunk?.length ?? 0)
      receivedMessages += 1
      receivedBytes += bytes
      if (receivedMessages === MESSAGES) {
        const totalMs = Date.now() - sendStart
        const bytesPerSecond = (receivedBytes / totalMs) * 1000
        const mibPerSecond = bytesPerSecond / (1024 * 1024)
        finish({
          ok: true,
          connectMs: sendStart - start,
          sendMs: totalMs,
          mibPerSecond
        })
      }
    }

    pc2.ondatachannel = (event) => {
      dc2 = event.channel
      dc2.binaryType = 'arraybuffer'
      dc2.onerror = (errorEvent) => {
        finish({ ok: false, reason: `dc2: ${errorEvent?.message || 'error'}` })
      }
      dc2.onmessage = (messageEvent) => {
        onIncomingChunk(messageEvent.data)
      }
    }

    dc1.onopen = async () => {
      if (connectTimeout) clearTimeout(connectTimeout)
      sendStart = Date.now()
      sendTimeout = setTimeout(() => {
        finish({ ok: false, reason: 'send-timeout' })
      }, SEND_TIMEOUT_MS)

      const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
      const YIELD_EVERY = 32

      try {
        for (let i = 0; i < MESSAGES; i++) {
          if (done) return

          while ((dc1.bufferedAmount || 0) > MAX_BUFFERED_BYTES) {
            if (done) return
            // Yield while the data channel drains to avoid starving timers and receiver callbacks.
            // eslint-disable-next-line no-await-in-loop
            await sleep(2)
          }

          dc1.send(payload)

          if ((i + 1) % YIELD_EVERY === 0) {
            // Keep the event loop responsive for high-volume runs.
            // eslint-disable-next-line no-await-in-loop
            await sleep(0)
          }
        }
      } catch (error) {
        finish({ ok: false, reason: `send: ${error?.message || error}` })
      }
    }

    const runSignaling = async () => {
      try {
        const offer = await pc1.createOffer()
        await pc1.setLocalDescription(offer)
        await pc2.setRemoteDescription(offer)
        await flushCandidates(pc2, pendingOnPc2)

        const answer = await pc2.createAnswer()
        await pc2.setLocalDescription(answer)
        await pc1.setRemoteDescription(answer)
        await flushCandidates(pc1, pendingOnPc1)
      } catch (error) {
        finish({ ok: false, reason: `signal: ${error?.message || error}` })
      }
    }

    void runSignaling()
  })
}

const benchmarkBackend = async (name) => {
  const wrtc = await getImplementation(name)
  if (!isValidWrtc(wrtc)) {
    throw new Error(`${name} implementation does not match wrtc contract`)
  }

  const results = []
  for (let i = 0; i < ITERATIONS; i++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runIteration(wrtc)
    results.push(result)
  }

  const successes = results.filter((r) => r.ok)
  const failures = results.filter((r) => !r.ok)

  const connectTimes = successes.map((r) => r.connectMs)
  const throughputs = successes.map((r) => r.mibPerSecond)

  return {
    backend: name,
    iterations: ITERATIONS,
    successCount: successes.length,
    failureCount: failures.length,
    failures: failures.map((f) => f.reason),
    connectAvgMs: connectTimes.length
      ? Math.round(
          connectTimes.reduce((a, b) => a + b, 0) / connectTimes.length
        )
      : null,
    connectP95Ms: percentile(connectTimes, 95),
    throughputAvgMiBs: throughputs.length
      ? Number(
          (throughputs.reduce((a, b) => a + b, 0) / throughputs.length).toFixed(
            2
          )
        )
      : null,
    throughputP95MiBs: throughputs.length
      ? Number((percentile(throughputs, 95) || 0).toFixed(2))
      : null
  }
}

const main = async () => {
  const backends = ['koush']

  console.log(
    `Running WRTC benchmark with iterations=${ITERATIONS}, messages=${MESSAGES}, payloadBytes=${PAYLOAD_BYTES}, connectTimeoutMs=${CONNECT_TIMEOUT_MS}, sendTimeoutMs=${SEND_TIMEOUT_MS}`
  )

  const summaries = []
  for (const backend of backends) {
    // eslint-disable-next-line no-await-in-loop
    const summary = await benchmarkBackend(backend)
    summaries.push(summary)
  }

  console.log('\nBenchmark Results')
  for (const summary of summaries) {
    console.log(`\n${summary.backend}`)
    console.log(`  success: ${summary.successCount}/${summary.iterations}`)
    console.log(`  connect avg ms: ${summary.connectAvgMs ?? 'n/a'}`)
    console.log(`  connect p95 ms: ${summary.connectP95Ms ?? 'n/a'}`)
    console.log(`  throughput avg MiB/s: ${summary.throughputAvgMiBs ?? 'n/a'}`)
    console.log(`  throughput p95 MiB/s: ${summary.throughputP95MiBs ?? 'n/a'}`)
    if (summary.failures.length) {
      console.log(`  failures: ${summary.failures.join(' | ')}`)
    }
  }

  // Native WebRTC bindings can abort during process teardown after benchmarks complete.
  // Exit explicitly once output is flushed.
  setTimeout(() => process.exit(0), 25)
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exit(1)
})

import Server from './../exports/server.js'

const port = Number(process.env.SWARM_TEST_PORT || 44444)
const mode = process.env.SWARM_TEST_SERVER_MODE || ''

const swarmServer = new Server({ version: 1, port })

const waitForPeers = async (server, peerIds, timeoutMs = 10_000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const allPresent = peerIds.every((peerId) => server.peers.has(peerId))
    if (allPresent) return true
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

const runServerMode = async () => {
  if (!mode) return

  const ready = await waitForPeers(swarmServer, ['peer-1', 'peer-2'])
  if (!ready) {
    console.warn(`server mode ${mode}: peers did not join in time`)
    return
  }

  if (mode === 'push') {
    swarmServer.sendToPeer('peer-1', {
      type: 'server-push',
      value: 'direct'
    })
    swarmServer.broadcastToPeers({
      type: 'server-push',
      value: 'broadcast'
    })
    return
  }

  if (mode === 'request') {
    try {
      const response = await swarmServer.requestFromPeer(
        'peer-2',
        'server:echo',
        { value: 'ping' },
        10_000
      )
      try {
        swarmServer.sendToPeer('peer-1', {
          type: 'server-request-result',
          ok: true,
          response
        })
      } catch (sendError) {
        console.warn(`server request result send failed: ${sendError}`)
      }
    } catch (error) {
      try {
        swarmServer.sendToPeer('peer-1', {
          type: 'server-request-result',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      } catch (sendError) {
        console.warn(`server request error send failed: ${sendError}`)
      }
    }
  }
}

void runServerMode()

import server from 'socket-request-server'
import { createDebugger } from '@vandeurenglenn/debug'
const debug = createDebugger('@netpeer/swarm/server')

type PeerTransportKind = 'webrtc' | 'webtransport'

type PeerRecord = {
  connection: WebSocket
  version: string
  transport: {
    kind: PeerTransportKind
    kinds: PeerTransportKind[]
  }
}

type CircuitPhase = 'request' | 'response'

type CircuitPayload = {
  to: string
  from: string
  id: string
  phase: CircuitPhase
  method?: string
  data?: unknown
  error?: string
}

type PendingServerCircuitRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export default class Server {
  peers: Map<string, PeerRecord> = new Map()
  #pendingServerCircuitRequests: Map<string, PendingServerCircuitRequest> =
    new Map()

  constructor(port = 44444, networkVersion = 'peach') {
    server(
      { port, protocol: networkVersion },
      {
        join: this.#join,
        leave: this.#leave,
        signal: this.#signal,
        circuit: this.#circuit,
        peers: ({ connection }) =>
          connection.send(
            JSON.stringify({
              url: 'peers',
              status: 200,
              value: [...this.peers.entries()].map(([peerId, peer]) => ({
                peerId,
                version: peer.version,
                transport: peer.transport
              }))
            })
          )
        // dial({ from, to }) {
        //   const toPeer = this.peers.get(to)
        //   const fromPeer = this.peers.get(from)
        // },
        // offer({ offer, to }) {
        //   const connection = this.peers.get(to)
        //   connection.send(offer)
        // },
        // answer({ answer, to }) {
        //   const connection = this.peers.get(to)
        //   connection.send(answer)
        // }
      }
    )
  }

  #join = (
    {
      peerId,
      version,
      transport
    }: {
      peerId: string
      version: string
      transport?: { kind?: PeerTransportKind; kinds?: PeerTransportKind[] }
    },
    { connection }: { connection: WebSocket }
  ) => {
    const advertisedKinds = Array.isArray(transport?.kinds)
      ? [
          ...new Set(
            transport.kinds.filter(
              (kind) => kind === 'webrtc' || kind === 'webtransport'
            )
          )
        ]
      : []

    const peerKinds = advertisedKinds.length
      ? advertisedKinds
      : transport?.kind === 'webtransport'
        ? ['webtransport']
        : ['webrtc']

    const peerTransport = {
      kind:
        transport?.kind && peerKinds.includes(transport.kind)
          ? transport.kind
          : peerKinds.includes('webrtc')
            ? 'webrtc'
            : 'webtransport',
      kinds: peerKinds
    }
    // A broadcast tells existing peers about the newcomer, but the newcomer
    // also needs the peers that joined before it. Without this snapshot a
    // four-node star produces a one-way 3/2/1/0 discovery graph.
    for (const [existingPeerId, existingPeer] of this.peers) {
      connection.send(
        JSON.stringify({
          url: 'peer:joined',
          status: 200,
          value: {
            peerId: existingPeerId,
            version: existingPeer.version,
            transport: existingPeer.transport
          }
        })
      )
    }

    this.peers.set(peerId, {
      connection,
      version,
      transport: peerTransport
    })
    this.#broadcast('peer:joined', {
      peerId,
      version,
      transport: peerTransport
    })
    debug(
      `Peer joined: ${peerId} (version: ${version}, transport: ${peerTransport.kind})`
    )
  }

  #leave = (peerId: string) => {
    // 1000 means normal close
    const peer = this.peers.get(peerId)
    if (!peer) {
      console.warn(`No connection found for peer ${peerId}`)
      return
    }
    peer.connection.close(1000, `${peerId} left`)
    this.peers.delete(peerId)
    this.#broadcast('peer:left', peerId)
    debug(`Peer left: ${peerId}`)
  }

  #signal = ({ to, from, channelName, signal, version }, connection) => {
    const toPeer = this.peers.get(to)
    if (!toPeer) {
      console.warn(`No peer found with id ${to}`)
      return
    }
    if (!toPeer.transport.kinds.includes('webrtc')) {
      debug(
        `Ignoring signal to ${to}: peer transport capabilities are ${toPeer.transport.kinds.join(',')}`
      )
      return
    }
    toPeer.connection.send(
      JSON.stringify({
        url: 'signal',
        status: 200,
        value: { channelName, signal, from, version }
      })
    )
    debug(`Signal sent from ${from} to ${to} (version: ${version})`)
  }

  #circuit = (payload: CircuitPayload, context: unknown) => {
    const connection =
      (context as { connection?: WebSocket })?.connection ||
      (context as WebSocket)

    if (!connection) {
      console.warn('Circuit request missing connection context')
      return
    }

    const { to, from, id, phase, method, data, error } = payload || {}
    if (
      typeof to !== 'string' ||
      typeof from !== 'string' ||
      typeof id !== 'string' ||
      (phase !== 'request' && phase !== 'response')
    ) {
      console.warn('Invalid circuit payload')
      return
    }

    if (to === 'server' && phase === 'response') {
      const pending = this.#pendingServerCircuitRequests.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.#pendingServerCircuitRequests.delete(id)
      if (error) {
        pending.reject(new Error(String(error)))
      } else {
        pending.resolve(data)
      }
      return
    }

    const fromPeer = this.peers.get(from)
    if (!fromPeer) {
      console.warn(`Circuit sender not found for peer ${from}`)
      return
    }
    if (fromPeer.connection !== connection) {
      debug(
        `Circuit sender connection differs for ${from}; forwarding based on peerId`
      )
    }

    const toPeer = this.peers.get(to)
    if (!toPeer) {
      connection.send(
        JSON.stringify({
          url: 'circuit',
          status: 404,
          value: {
            to: from,
            from: 'server',
            id,
            phase: 'response',
            error: `peer ${to} not found`
          }
        })
      )
      return
    }

    toPeer.connection.send(
      JSON.stringify({
        url: 'circuit',
        status: 200,
        value: {
          to,
          from,
          id,
          phase,
          method,
          data,
          error
        }
      })
    )
    debug(`Circuit ${phase} forwarded from ${from} to ${to} (${id})`)
  }

  #createCircuitId(): string {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto)
    }
    return `server-circuit-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  sendToPeer(peerId: string, data: unknown, url = 'server:data') {
    const peer = this.peers.get(peerId)
    if (!peer) {
      throw new Error(`No peer found with id ${peerId}`)
    }
    peer.connection.send(
      JSON.stringify({
        url,
        status: 200,
        value: data
      })
    )
  }

  broadcastToPeers(data: unknown, url = 'server:data') {
    this.#broadcast(url, data)
  }

  requestFromPeer(
    peerId: string,
    method: string,
    data?: unknown,
    timeoutMs = 30_000
  ): Promise<unknown> {
    const peer = this.peers.get(peerId)
    if (!peer) {
      return Promise.reject(new Error(`No peer found with id ${peerId}`))
    }

    const id = this.#createCircuitId()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingServerCircuitRequests.delete(id)
        reject(new Error(`server circuit request for ${id} timed out`))
      }, timeoutMs)

      this.#pendingServerCircuitRequests.set(id, { resolve, reject, timeout })

      peer.connection.send(
        JSON.stringify({
          url: 'circuit',
          status: 200,
          value: {
            to: peerId,
            from: 'server',
            id,
            phase: 'request',
            method,
            data
          }
        })
      )
    })
  }

  #broadcast(url: string, value: any) {
    for (const peer of this.peers.values()) {
      peer.connection.send(
        JSON.stringify({
          url,
          value,
          status: 200
        })
      )
    }
    debug(`Broadcasted ${url} to ${this.peers.size} peers`)
  }

  // #sendToPeer = ({ send }: WebSocket, url: string, value: any) =>
  //   send(JSON.stringify({ url, status: 200, value }))
}

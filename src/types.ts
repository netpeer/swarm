export type Options = {
  peerId: string
  networkVersion: string // websocket.protocol
  version: string // version string to pass to a star when connecting
  stars: string[]
  transport?: {
    kind?: 'webrtc' | 'webtransport'
    kinds?: ('webrtc' | 'webtransport')[]
    preferredKind?: 'webrtc' | 'webtransport'
    fallback?: {
      enabled?: boolean
      connectTimeoutMs?: number
      order?: ('webrtc' | 'webtransport' | 'circuit')[]
    }
    webtransport?: {
      urlTemplate?: string
    }
  }
  /** defaults to peer:connected, can be renamed to handle different protocols, like peer:discovered (setup peer props before fireing the connect event) */
  connectEvent?: string
  attempts?: number
  // optional retry/backoff for star connections
  retry?: {
    retries?: number
    factor?: number
    minTimeout?: number
    maxTimeout?: number
  }
  testHooks?: {
    skipInit?: boolean
    allowConnectWithoutStar?: boolean
    createPeer?: (args: {
      kind: 'webrtc' | 'webtransport' | 'circuit'
      peerId: string
      version: string
      initiator: boolean
      star?: string
      url?: string
    }) => {
      connected: boolean
      initiator: boolean
      peerId: string
      channelName: string
      on: (event: string, handler: (...args: unknown[]) => void) => unknown
      off: (event: string, handler: (...args: unknown[]) => void) => unknown
      signal: (signalData: unknown) => void
      destroy: () => void
      send: (data: Uint8Array, id?: string) => void
      request: (data: Uint8Array, id?: string) => Promise<Uint8Array>
    } | null
    onTransportEvent?: (event: {
      type:
        | 'attempt-started'
        | 'attempt-advanced'
        | 'attempt-timeout'
        | 'attempt-error'
        | 'connected'
        | 'attempts-exhausted'
      peerId: string
      transport: 'webrtc' | 'webtransport' | 'circuit'
      attemptIndex: number
      order: ('webrtc' | 'webtransport' | 'circuit')[]
      reason?: string
    }) => void
  }
}

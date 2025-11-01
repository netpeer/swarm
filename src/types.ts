export type Options = {
  peerId: string
  networkVersion: string // websocket.protocol
  version: string // version string to pass to a star when connecting
  stars: string[]
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
}

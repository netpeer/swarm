import { createNetwork, PEERNET_APP_ID } from '../namespace.js'
export const MAX_MESSAGE_SIZE = 16000

export const defaultOptions = {
  network: createNetwork(PEERNET_APP_ID,'public'),
  protocolVersion: 'v1',
  stars: ['wss://star.leofcoin.org'],
  connectEvent: 'peer:connected'
}

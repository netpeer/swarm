import { broadcastPubSubMessage, sendPubSubMessage } from './utils.js'
import SocketServer from 'socket-request-server'
import { readFile, writeFile } from 'fs'
import { promisify } from 'util'
import generateAccount from '@leofcoin/generate-account'

const read = promisify(readFile)
const write = promisify(writeFile)

const peers = {}
 
const cleanupJob = () => setTimeout(() => {
  // loop trough know connections and check if they still connected
  for (const [id, connection] of Object.entries(peers)) {
    if (connection.connected === false) {
      delete peers[id]
      broadcastPubSubMessage('peer:left', id, peers)
    }
  }
  cleanupJob()
}, 1000);

cleanupJob()

/**
 * @params {String} id - id of the peer joined
 */
const peerJoined = id => {
  // cleanup leftover connection (sometimes peers don't have the time to send leave message...)
  delete peers[id]
  // tell everyone a peer joined
  broadcastPubSubMessage('peer:joined', id, peers)
}

/**
 * @params {String} id - id of the peer left
 */
const peerLeft = id => {
  // remove connection from peers
  delete peers[id]
  // tell everyone a peer left
  broadcastPubSubMessage('peer:left', id, peers)
}

export default class Server {
  constructor(port = 44444, network = 'leofcoin:peach') {
    return this._init(port, network)
  }

  async _init(port, network) {
    this.port = port
    this.network = network
    const parts = network.split(':')
    this.networkVersion = parts.length > 1 ? parts[1] : 'mainnet'

      let config
      try {
        config = await read('./star-id.json')
        config = JSON.parse(config)
      } catch (e) {
        config = await generateAccount(network)
        await write('./star-id.json', JSON.stringify(config, null, '\t'))
      }
      config = {
        identity: {
          publicKey: config.identity.publicKey
        }
      }
      
      this.socketserver = SocketServer({port, protocol: this.networkVersion}, {
        peernet: (params, response) => {
          // peer left
          if (!params.join) return peerLeft(params.id)

          peerJoined(params.id)
          peers[params.id] = response.connection
          response.send(Object.keys(peers))
        },
         signal: (params, response) => {
          if (params.to) {
            sendPubSubMessage('signal', params, peers[params.to])
            // sendPubSubMessage('signal', params, peers[params.from])
          } else {
            broadcastPubSubMessage('signal', params, peers)
          }
        },
        id: (params, response) => {
          response.send(config.identity.publicKey)
        }
      })
      // pubsub.subscribe('signal', message => {

      // })



      process.on('SIGINT', () => {
        process.stdin.resume();
        broadcastPubSubMessage('star:left', config.identity.publicKey, peers)
        process.exit()
      });

      return this
  }
}

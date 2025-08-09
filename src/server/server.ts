import server from 'socket-request-server'

export default class Server {
  peers: Map<string, WebSocket> = new Map()
  constructor(port = 44444, networkVersion = 'peach') {
    server(
      { port, protocol: networkVersion },
      {
        join: this.#join,
        leave: this.#leave,
        signal: this.#signal,
        peers: ({ connection }) =>
          connection.send(
            JSON.stringify({
              url: 'peers',
              status: 200,
              value: [...this.peers.keys()]
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
    { peerId, version }: { peerId: string; version: string },
    { connection }: { connection: WebSocket }
  ) => {
    this.peers.set(peerId, connection)
    this.#broadcast('peer:joined', { peerId, version })
  }

  #leave = (peerId: string) => {
    // 1000 means normal close
    const connection = this.peers.get(peerId)
    connection.close(1000, `${peerId} left`)
    this.peers.delete(peerId)
    this.#broadcast('peer:left', peerId)
  }

  #signal = ({ to, from, channelName, signal, version }, connection) => {
    const toPeer = this.peers.get(to)

    toPeer.send(
      JSON.stringify({
        url: 'signal',
        status: 200,
        value: { channelName, signal, from, version }
      })
    )
  }

  #broadcast(url: string, value: any) {
    for (const connection of this.peers.values()) {
      connection.send(
        JSON.stringify({
          url,
          value,
          status: 200
        })
      )
    }
  }

  // #sendToPeer = ({ send }: WebSocket, url: string, value: any) =>
  //   send(JSON.stringify({ url, status: 200, value }))
}

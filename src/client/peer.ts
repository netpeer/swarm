import '@vandeurenglenn/debug'

export default class Peer {
  #connection
  #connected = false
  #messageQue = []
  #chunksQue = {}
  #channel
  #peerId: string
  #channelName
  #chunkSize = 16 * 1024 // 16384
  #queRunning = false
  #MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024
  initiator: boolean = false
  state: string
  #makingOffer: boolean = false

  get connection() {
    return this.#connection
  }

  get connected() {
    return this.#connected
  }

  get readyState() {
    return this.#channel?.readyState
  }

  /**
   * @params {Object} options
   * @params {string} options.channelName - this peerid : otherpeer id
  */
  constructor(options = {}) {
    this.#pubsub = new LittlePubSub()
    this._in = this._in.bind(this);
    this.offerOptions = options.offerOptions
    this.initiator = options.initiator
    this.streams = options.streams
    this.socketClient = options.socketClient
    this.id = options.id
    this.to = options.to
    this.bw = {
      up: 0,
      down: 0
    }

    this.#channelName = options.channelName

    this.#peerId = options.peerId
    this.options = options
    return this.#init()
  }

  get peerId() {
    return this.#peerId
  }

  set socketClient(value) {
    // this.socketClient?.pubsub.unsubscribe('signal', this._in)
    this._socketClient = value
    this._socketClient.pubsub.subscribe('signal', this._in)
  }

  get socketClient() {
    return this._socketClient
  }

  splitMessage(message) {
    const chunks = []
    message = pako.deflate(message)
    const size = message.byteLength || message.length
    let offset = 0
    return new Promise((resolve, reject) => {
      const splitMessage = () => {
        const chunk = message.slice(offset, offset + this.#chunkSize > size ? size : offset + this.#chunkSize)
        offset += this.#chunkSize
        chunks.push(chunk)
        if (offset < size) return splitMessage()
        else resolve({chunks, size})
      }

      splitMessage()
    })
  }

  async #runQue() {
    this.#queRunning = true
    if (this.#messageQue.length > 0 && this.#channel?.bufferedAmount + this.#messageQue[0]?.length < this.#MAX_BUFFERED_AMOUNT) {
      const message = this.#messageQue.shift()

      switch (this.#channel?.readyState) {
        case 'open':
        await this.#channel.send(message);
        if (this.#messageQue.length > 0) return this.#runQue()
        else this.#queRunning = false
        break;
        case 'closed':
        case 'closing':
        this.#messageQue = []
        this.#queRunning = false
        debug('channel already closed, this usually means a bad implementation, try checking the readyState or check if the peer is connected before sending');
        break;
        case undefined:
        this.#messageQue = []
        this.#queRunning = false
        debug(`trying to send before a channel is created`);
        break;
      }


    } else {
      return setTimeout(() => this.#runQue(), 50)
    }
  }

  #trySend({ size, id, chunks }) {
    let offset = 0

    for (const chunk of chunks) {
      const start = offset
      const end = offset + chunk.length

      const message = new TextEncoder().encode(JSON.stringify({ size, id, chunk, start, end }));
      this.#messageQue.push(message)
    }

    if (!this.queRunning) return this.#runQue()
  }

  async send(message, id) {
    const { chunks, size } = await this.splitMessage(message)
    return this.#trySend({ size, id, chunks })
  }

  request(data) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(-12)

      const _onData = message => {
        if (message.id === id) {
          resolve(message.data)
          pubsub.unsubscribe(`peer:data`, _onData)
        }
      }

      pubsub.subscribe(`peer:data`, _onData)

      // cleanup subscriptions
      // setTimeout(() => {
      //   pubsub.unsubscribe(`peer:data-request-${id}`, _onData)
      // }, 5000);

      this.send(data, id)
    })
  }

  async #init() {
    try {

      if (!globalThis.pako) {
        const importee = await import('pako')
        globalThis.pako = importee.default
      }

      const iceServers = [{
        urls: 'stun:stun.l.google.com:19302' // Google's public STUN server
      }, {
        urls: "stun:openrelay.metered.ca:80",
      }, {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
      }, {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
      }]

      this.#connection = new wrtc.RTCPeerConnection({iceServers});

      this.#connection.onnegotiationneeded = async () => {
        try {
          this.#makingOffer = true;
          await this.#connection.setLocalDescription();
          this._sendMessage({ description: this.#connection.localDescription });
          this.#makingOffer = false;
        } catch (err) {
          console.error(err);
        }
      }

      this.#connection.oniceconnectionstatechange = () => {
        if (this.#connection.iceConnectionState === "failed") {
          this.#connection.restartIce();
        }
      };

      this.#connection.onconnectionstatechange = () => {
        switch (this.#connection.connectionState) {
          case "new":
          case "checking":
            this.state = "connecting"
            break;
          case "connected":
            this.state = 'connected'
            break;
          case "closed":
          case "disconnected":
            this.state = "disconnected"
            break;
          case "failed":
            this.state = 'failed';
            break;
          default:
            this.state = this.#connection.connectionState
            break;
        }

        if (this.state === 'connected') {
          this.#connection.ondatachannel = (message) => {
            message.channel.onopen = () => {
              this.#connected = true
            //  debug(`peer:connected ${this}`)
              pubsub.publish('peer:connected', this)
            }
            message.channel.onclose = () => this.close.bind(this)
    
            message.channel.onmessage = (message) => {
              this._handleMessage(this.id, message)
            }
            this.#channel = message.channel
          }
          if (this.initiator) {
      
            this.#channel = this.#connection.createDataChannel('messageChannel')
            this.#channel.onopen = () => {
              this.#connected = true
              pubsub.publish('peer:connected', this)
              // this.#channel.send('hi')
            }
            this.#channel.onclose = () => this.close.bind(this)
      
            this.#channel.onmessage = (message) => {
              this._handleMessage(this.peerId, message)
            }
          }
        }
      };

      this.#connection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          this.address = candidate.address
          this.port = candidate.port
          this.protocol = candidate.protocol
          this.ipFamily = this.address.includes('::') ? 'ipv6': 'ipv4'
          this._sendMessage({candidate})
        }
      }
      // if (this.initiator) this.#connection.onnegotiationneeded = () => {
        // console.log('create offer');
    
    } catch (e) {
      console.log(e);
    }

    return this
  }

  _handleMessage(peerId, message) {
  //  debug(`incoming message from ${peerId}`)

    message = JSON.parse(new TextDecoder().decode(message.data))
    // allow sharding (multiple peers share data)
    pubsub.publish('peernet:shard', message)
    const { id } = message

    if (!this.#chunksQue[id]) this.#chunksQue[id] = []

    if (message.size > this.#chunksQue[id].length || message.size === this.#chunksQue[id].length) {
      for (const value of Object.values(message.chunk)) {
        this.#chunksQue[id].push(value)
      }
    }

    if (message.size === this.#chunksQue[id].length) {
      let data = new Uint8Array(Object.values(this.#chunksQue[id]))
      delete this.#chunksQue[id]
      data = pako.inflate(data)
      pubsub.publish('peer:data', { id, data, from: this.peerId })
    }
    this.bw.down += message.byteLength || message.length
  }

  _sendMessage(message) {
    this.socketClient.send({url: 'signal', params: {
      to: this.to,
      from: this.id,
      channelName: this.options.channelName,
      ...message
    }})
  }

  async _in(message, data) {
    let ignoreOffer = false;

    try {
      if (message.description) {
        const offerCollision =
          message.description.type === "offer" &&
          (this.#makingOffer || this.#connection.signalingState !== "stable");
  
        ignoreOffer = this.initiator && offerCollision;
        if (ignoreOffer) {
          return;
        }
  
        await this.#connection.setRemoteDescription(message.description);
        if (message.description.type === "offer") {
          await this.#connection.setLocalDescription();
          this._sendMessage({ description: this.#connection.localDescription });
        }
      } else if (message.candidate) {
        try {
          await this.#connection.addIceCandidate(message.candidate);
        } catch (err) {
          if (!ignoreOffer) {
            throw err;
          }
        }
      }
    } catch (e) {
      pubsub.publish('connection closed', this)
      console.log(e);
      this.close()
    }
  }

  close() {
  //  debug(`closing ${this.peerId}`)
    this.#connected = false
    this.#channel?.close()
    this.#connection?.close()

    this.socketClient.pubsub.unsubscribe('signal', this._in)
  }
}

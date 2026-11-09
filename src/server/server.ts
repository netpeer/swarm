import server from './star-socket.js'
import { RelayTickets } from './relay-tickets.js'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { normalizeNamespace, namespaceKey, STAR_PROTOCOL, type Namespace } from '../namespace.js'
import { starCodec, MAX_STAR_MESSAGE_BYTES } from '../client/star-connection.js'

type Socket = any
type PeerTransportKind = 'webrtc' | 'webtransport'
type PeerRecord = {connection:Socket;version:string;transport:{kind:PeerTransportKind;kinds:PeerTransportKind[]}}
type Group = {key:string;namespace:Readonly<Namespace> | null;peers:Map<string,PeerRecord>}
type Registration = {peerId:string;group:Group}
type Pending = {peerId:string;connection:Socket;resolve:Function;reject:Function;timeout:ReturnType<typeof setTimeout>}

/** One listener; immutable per-connection registration; no peer traffic crosses a group. */
export default class Server {
  #groups = new Map<string,Group>()
  #registrations = new WeakMap<object,Registration>()
  #protocols = new WeakMap<object,string>()
  #pendingServerCircuitRequests = new Map<string,Pending>()
  #registrationTimers = new Map<Socket,ReturnType<typeof setTimeout>>()
  #relayUrl?: string
  #httpServer = createServer()
  #socketServer:ReturnType<typeof server>
  #closing = false
  #maxGroups:number
  #maxPeers:number
  ready:Promise<void>

  constructor(port = 44444, _legacyNetwork = 'peach', options: {
    relaySecret?:string;relayUrl?:string;legacy?:boolean;maxNamespaces?:number;maxPeersPerNamespace?:number
  } = {}) {
    this.#maxGroups = options.maxNamespaces ?? 128
    this.#maxPeers = options.maxPeersPerNamespace ?? 512
    if (![this.#maxGroups,this.#maxPeers].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096))
      throw new Error('Invalid Star namespace capacity')
    const tickets = options.relaySecret ? new RelayTickets(options.relaySecret) : null
    if (options.relayUrl) {
      const url = new URL(options.relayUrl)
      if (!tickets || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid WebTransport relay URL')
      this.#relayUrl = url.href
    }
    this.#socketServer = server({
      httpServer:this.#httpServer,port,protocol:[STAR_PROTOCOL],allowLegacy:options.legacy !== false,
      maxConnections:4096,maxReceivedMessageSize:MAX_STAR_MESSAGE_BYTES,
      codecForProtocol:(protocol:string) => protocol === STAR_PROTOCOL ? starCodec : undefined,
      onConnection:(connection:Socket,protocol:string) => {
        this.#protocols.set(connection,protocol)
        this.#registrationTimers.set(connection,setTimeout(() => connection.close(1008,'Registration timeout'),10000))
        connection.on('close',() => this.#remove(connection))
      }
    }, {
      join:this.#join,leave:this.#leave,signal:this.#signal,circuit:this.#circuit,
      peers:(first:any,response?:any) => {
        const context = response?.connection ? response : first, registration = this.#registrations.get(context.connection)
        context.send(registration ? [...registration.group.peers].map(([peerId,peer]) => this.#announcement(peerId,peer,registration.group)) : [],registration ? 200 : 403)
      },
      'webtransport-ticket':(params:any,response:any) => {
        const registered = this.#registrations.get(response.connection)
        const target = registered?.group.peers.get(params?.to)
        const source = registered?.group.peers.get(params?.from)
        if (!tickets || !registered || !source || params.from !== registered.peerId || source.connection !== response.connection ||
          !target || params.from === params.to || !source.transport.kinds.includes('webtransport') || !target.transport.kinds.includes('webtransport')) {
          response.send({error:'relay unavailable or peer not authorized'},403); return
        }
        response.send({ticket:tickets.issue(params.from,params.to,registered.group.namespace?.network || this.#protocols.get(response.connection),source.version,registered.group.key)})
      }
    })
    this.ready = Promise.all([this.#socketServer,new Promise<void>((resolve,reject) => {
      this.#httpServer.once('error',reject)
      this.#httpServer.listen(port,() => { console.log(`listening on ${(this.#httpServer.address() as any).port}`); resolve() })
    })]).then(() => {})
  }

  address() { return this.#httpServer.address() }

  get namespaces() { return [...this.#groups.values()].map(group => ({key:group.key,namespace:group.namespace,peers:group.peers.size})) }
  get peers() { return new Map(this.#adminGroup()?.peers || []) }
  peersFor(namespace:Namespace | string) { return new Map(this.#adminGroup(namespace)?.peers || []) }

  #adminGroup(namespace?:Namespace | string) {
    if (namespace !== undefined) {
      const key = typeof namespace === 'string' ? namespace : 'v3:' + namespaceKey(namespace)
      const group = this.#groups.get(key)
      if (!group) throw new Error('Unknown Star namespace')
      return group
    }
    if (this.#groups.size > 1) throw new Error('Ambiguous Star namespace: specify the network scope')
    return this.#groups.values().next().value as Group | undefined
  }

  #send(connection:Socket,message:unknown) { connection.sendResponse(message) }
  #announcement(peerId:string,peer:PeerRecord,group:Group) {
    return {peerId,version:peer.version,transport:peer.transport,...(group.namespace ? {namespace:group.namespace} : {})}
  }
  #broadcast(group:Group,url:string,value:unknown) {
    if (this.#closing) return
    for (const peer of group.peers.values()) { try {this.#send(peer.connection,{url,status:200,value})} catch {} }
  }

  #join = (params:any,response:any) => {
    const connection = response.connection
    if (!params || typeof params.peerId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(params.peerId) || params.peerId === 'server') {
      response.send({error:'Invalid peer registration'},400); return
    }
    let namespace:Readonly<Namespace> | null = null, key:string, version:string
    try {
      if (this.#protocols.get(connection) === STAR_PROTOCOL) {
        namespace = normalizeNamespace(params.namespace)
        if (['version','networkVersion','protocol','discoveryNetwork'].some(name => Object.hasOwn(params,name))) throw new Error('Removed registration fields')
        version = namespace.protocolVersion
        key = 'v3:' + namespaceKey(namespace)
      } else {
        if (params.namespace !== undefined) throw new Error('Legacy connection cannot select a namespace')
        if (typeof params.version !== 'string' || !/^[A-Za-z0-9._:/-]{1,64}$/.test(params.version)) throw new Error('Invalid legacy version')
        version = params.version
        key = 'legacy:' + JSON.stringify([this.#protocols.get(connection),params.version])
      }
    } catch { response.send({error:'Invalid network namespace'},400); return }
    const bound = this.#registrations.get(connection)
    if (bound && (bound.group.key !== key || bound.peerId !== params.peerId)) {
      response.send({error:'Connection registration is immutable'},403); return
    }
    let group = this.#groups.get(key)
    if (!group) {
      if (this.#groups.size >= this.#maxGroups) { response.send({error:'Namespace capacity reached'},503); return }
      group = {key,namespace,peers:new Map()}
    }
    const previous = group.peers.get(params.peerId)
    if (previous && previous.connection !== connection) { response.send({error:'Peer identity is already connected'},409); return }
    if (!previous && group.peers.size >= this.#maxPeers) { response.send({error:'Peer capacity reached'},503); return }
    const kinds:PeerTransportKind[] = Array.isArray(params.transport?.kinds)
      ? [...new Set<PeerTransportKind>(params.transport.kinds.filter((kind:string) => kind === 'webrtc' || kind === 'webtransport'))] : []
    if (!kinds.length) kinds.push(params.transport?.kind === 'webtransport' ? 'webtransport' : 'webrtc')
    const transport = {kind:(kinds.includes(params.transport?.kind) ? params.transport.kind : kinds[0]) as PeerTransportKind,kinds}
    const peer:PeerRecord = {connection,version,transport}
    this.#groups.set(key,group); group.peers.set(params.peerId,peer)
    this.#registrations.set(connection,{peerId:params.peerId,group})
    clearTimeout(this.#registrationTimers.get(connection)); this.#registrationTimers.delete(connection)
    response.send({namespace,registered:true})
    if (this.#relayUrl) this.#send(connection,{url:'relay:ready',status:200,value:{protocol:'swarm-relay/1',url:this.#relayUrl}})
    if (previous && JSON.stringify(previous.transport) === JSON.stringify(transport)) return
    for (const [peerId,existing] of group.peers) if (peerId !== params.peerId)
      this.#send(connection,{url:'peer:joined',status:200,value:this.#announcement(peerId,existing,group)})
    this.#broadcast(group,'peer:joined',this.#announcement(params.peerId,peer,group))
  }

  #remove(connection:Socket) {
    clearTimeout(this.#registrationTimers.get(connection)); this.#registrationTimers.delete(connection)
    const registered = this.#registrations.get(connection)
    if (!registered) return
    this.#registrations.delete(connection)
    if (registered.group.peers.get(registered.peerId)?.connection !== connection) return
    registered.group.peers.delete(registered.peerId)
    this.#broadcast(registered.group,'peer:left',registered.peerId)
    if (!registered.group.peers.size) this.#groups.delete(registered.group.key)
    for (const [id,pending] of this.#pendingServerCircuitRequests) if (pending.connection === connection) {
      clearTimeout(pending.timeout); this.#pendingServerCircuitRequests.delete(id); pending.reject(new Error('Star peer disconnected'))
    }
  }

  #leave = (peerId:string,response:any) => {
    if (this.#registrations.get(response.connection)?.peerId !== peerId) return
    this.#remove(response.connection); response.connection.close(1000,'Peer left')
  }

  #signal = (params:any,response:any) => {
    const registered = this.#registrations.get(response.connection), target = registered?.group.peers.get(params?.to)
    const source = registered?.group.peers.get(params?.from)
    if (!registered || !source || params.from !== registered.peerId || source.connection !== response.connection ||
      !target || params.to === params.from || params.version !== source.version ||
      !source.transport.kinds.includes('webrtc') || !target.transport.kinds.includes('webrtc')) return
    this.#send(target.connection,{url:'signal',status:200,value:{
      from:registered.peerId,version:source.version,channelName:params.channelName,signal:params.signal
    }})
  }

  #circuit = (payload:any,response:any) => {
    const connection = response.connection
    const registered = this.#registrations.get(connection)
    const {to,from,id,phase,method,data,error} = payload || {}
    if (!registered || from !== registered.peerId || typeof to !== 'string' ||
      typeof id !== 'string' || id.length < 1 || id.length > 128 || !['request','response'].includes(phase)) return
    if (to === 'server' && phase === 'response') {
      const pending = this.#pendingServerCircuitRequests.get(id)
      if (!pending || pending.connection !== connection || pending.peerId !== from) return
      clearTimeout(pending.timeout); this.#pendingServerCircuitRequests.delete(id)
      if (error) pending.reject(new Error(String(error))); else pending.resolve(data)
      return
    }
    const target = registered.group.peers.get(to)
    if (!target) {
      this.#send(connection,{url:'circuit',status:404,value:{to:from,from:'server',id,phase:'response',error:'Peer unavailable in this namespace'}})
      return
    }
    this.#send(target.connection,{url:'circuit',status:200,value:{to,from,id,phase,method,data,error}})
  }

  sendToPeer(peerId:string,data:unknown,url = 'server:data',namespace?:Namespace | string) {
    const peer = this.#adminGroup(namespace)?.peers.get(peerId)
    if (!peer) throw new Error('No peer in the selected Star namespace')
    this.#send(peer.connection,{url,status:200,value:data})
  }
  broadcastToPeers(data:unknown,url = 'server:data',namespace?:Namespace | string) {
    const group = this.#adminGroup(namespace)
    if (group) this.#broadcast(group,url,data)
  }
  requestFromPeer(peerId:string,method:string,data?:unknown,timeoutMs = 30000,namespace?:Namespace | string):Promise<unknown> {
    const peer = this.#adminGroup(namespace)?.peers.get(peerId)
    if (!peer) return Promise.reject(new Error('No peer in the selected Star namespace'))
    if (this.#pendingServerCircuitRequests.size >= 512) return Promise.reject(new Error('Star request capacity reached'))
    const id = randomUUID()
    return new Promise((resolve,reject) => {
      const timeout = setTimeout(() => {this.#pendingServerCircuitRequests.delete(id);reject(new Error('Star circuit request timed out'))},timeoutMs)
      this.#pendingServerCircuitRequests.set(id,{peerId,connection:peer.connection,resolve,reject,timeout})
      try { this.#send(peer.connection,{url:'circuit',status:200,value:{to:peerId,from:'server',id,phase:'request',method,data}}) }
      catch(error) { clearTimeout(timeout);this.#pendingServerCircuitRequests.delete(id);reject(error) }
    })
  }
  async close() {
    if (this.#closing) return
    this.#closing = true
    for (const timer of this.#registrationTimers.values()) clearTimeout(timer)
    this.#registrationTimers.clear()
    for (const pending of this.#pendingServerCircuitRequests.values()) {clearTimeout(pending.timeout);pending.reject(new Error('Star stopped'))}
    this.#pendingServerCircuitRequests.clear()
    try { (await this.#socketServer).close() }
    finally { if (this.#httpServer.listening) await new Promise<void>(resolve => this.#httpServer.close(() => resolve())) }
  }
}

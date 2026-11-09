import { server as WebSocketServer } from 'websocket'

/** Star-owned upgrade/codec dispatch. There are deliberately no generic pubsub/peernet routes. */
export default function starSocketServer(options: {
  httpServer:any;port:number;protocol:string[];allowLegacy:boolean;maxConnections:number;maxReceivedMessageSize:number;
  codecForProtocol:(protocol:string)=>any;onConnection:(connection:any,protocol:string)=>void
}, routes:Record<string,Function>) {
  const sockets = new Set<any>()
  const server = new WebSocketServer({httpServer:options.httpServer,autoAcceptConnections:false,
    maxReceivedMessageSize:options.maxReceivedMessageSize,maxReceivedFrameSize:options.maxReceivedMessageSize})
  server.on('request', request => {
    const protocol = request.requestedProtocols.find(value => options.protocol.includes(value)) ||
      (options.allowLegacy && request.requestedProtocols.find(value => /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.startsWith('swarm-')))
    if (!protocol || sockets.size >= options.maxConnections) {request.reject();return}
    let connection:any
    try { connection = request.accept(protocol,request.origin) } catch {request.reject();return}
    sockets.add(connection)
    connection.on('close',()=>sockets.delete(connection))
    const codec = options.codecForProtocol(protocol)
    connection.sendResponse = (value:unknown) => {
      if (codec) connection.sendBytes(Buffer.from(codec.encode(value)))
      else connection.sendUTF(JSON.stringify(value))
    }
    connection.on('message', async (message:any) => {
      let url='error', id:string | undefined
      try {
        if (codec && message.type !== 'binary') {connection.close(1003,'Binary Star messages required');return}
        const payload = codec ? codec.decode(new Uint8Array(message.binaryData)) : JSON.parse(message.type === 'utf8' ? message.utf8Data : message.binaryData.toString('utf8'))
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.url !== 'string' ||
          payload.url.length > 128 || (payload.id !== undefined && (typeof payload.id !== 'string' || payload.id.length > 128)))
          throw new Error('Invalid Star request')
        url=payload.url;id=payload.id
        const response = {connection,send:(value:unknown,status=200)=>connection.sendResponse({url,id,status,value})}
        if (url === 'ping') {response.send(Date.now());return}
        if (!Object.hasOwn(routes,url)) {response.send({error:'Unsupported Star route'},400);return}
        await routes[url](payload.params,response)
      } catch {try {connection.sendResponse({url,id,status:400,value:{error:'Invalid Star request'}})} catch {}}
    })
    try {options.onConnection(connection,protocol)} catch {connection.close(1008,'Connection refused')}
  })
  return {close:()=>server.shutDown()}
}

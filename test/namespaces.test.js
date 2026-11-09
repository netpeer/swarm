import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import Server from '../exports/server.js'
import Client from '../exports/client.js'
import { StarConnection, starCodec } from '../exports/star-connection.js'
import { namespaceKey, normalizeNamespace, createNetwork, parseNetwork, PEERNET_APP_ID } from '../exports/namespace.js'
import { RelayTickets } from '../exports/relay-tickets.js'

const otherAppId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const base = {network:createNetwork(PEERNET_APP_ID,'public'),protocolVersion:'v1'}
const secret = 'namespace-test-only-secret-32-bytes-minimum'
const tick = () => new Promise(resolve => setTimeout(resolve,20))
async function until(check) { for(let i=0;i<100;i++){if(check())return;await tick()}assert.fail('Star state timed out') }

test('namespace labels are bounded and absence of chainId is distinct from every chain', () => {
  assert.equal(namespaceKey(base),namespaceKey({...base,chainId:undefined}))
  assert.notEqual(namespaceKey(base),namespaceKey({...base,chainId:'lfc:one'}))
  for(const value of [null,{}, {...base,chainId:null},{...base,chainId:''},{...base,network:'../bad network'},{...base,extra:'no'}, {...base,protocolVersion:5}])
    assert.throws(()=>normalizeNamespace(value))
  const client = new Client({peerId:'test',...base,stars:[],testHooks:{skipInit:true}})
  assert.equal(Object.hasOwn(client.namespace,'chainId'),false)
  assert.deepEqual(parseNetwork(base.network),{appId:PEERNET_APP_ID,name:'public'})
  for(const name of ['protocol','networkVersion','version','discoveryNetwork'])
    assert.throws(()=>new Client({peerId:'test',...base,[name]:undefined,stars:[],testHooks:{skipInit:true}}),/was removed/)
  for(const appId of ['chat','',PEERNET_APP_ID.toUpperCase(),'../bad'])assert.throws(()=>createNetwork(appId,'public'))
  assert.throws(()=>normalizeNamespace({...base,protocol:'old'}))
})

test('SDK server-data subscriptions are instance-local even with identical peer IDs',async t=>{
  const server=new Server(0);await server.ready;t.after(()=>server.close())
  const clients=[],received=[[],[]]
  t.after(()=>Promise.all(clients.map(client=>client.close())))
  for(let index=0;index<2;index++){
    const client=new Client({peerId:'same',...base,network:createNetwork(index ? otherAppId : PEERNET_APP_ID,'public'),stars:[`ws://127.0.0.1:${server.address().port}`],
      transport:{kinds:['webtransport'],fallback:{order:['circuit']}},retry:{retries:0}})
    clients.push(client);client.onServerData(value=>received[index].push(value));await client.ready
  }
  server.sendToPeer('same',new Uint8Array([8]),'server:data',clients[0].namespace)
  await until(()=>received[0].length===1)
  assert.deepEqual(received,[ [new Uint8Array([8])], [] ])
})

test('the native socket rejects text responses without an invalid reserved close code',async t=>{
  const server=new Server(0);await server.ready;t.after(()=>server.close())
  const socket=await new StarConnection(`ws://127.0.0.1:${server.address().port}`).init();t.after(()=>socket.close())
  await socket.request({url:'join',params:{peerId:'a',namespace:base}})
  server.peersFor(base).get('a').connection.sendUTF('{"url":"circuit","value":{}}')
  await until(()=>socket.connectionState()==='closed')
})

test('one Star isolates discovery, signals, circuits, tickets and operator sends across protocol/network/version/optional chain', {timeout:15000}, async t => {
  const server = new Server(0,'peach',{relaySecret:secret})
  await server.ready; t.after(()=>server.close())
  const url = `ws://127.0.0.1:${server.address().port}`
  const all=[]
  async function connect(peerId, namespace) {
    const socket = await new StarConnection(url).init(); all.push(socket)
    const events=[]
    for(const topic of ['peer:joined','peer:left','signal','circuit','server:data'])socket.pubsub.subscribe(topic,value=>events.push({topic,value}))
    await socket.request({url:'join',params:{peerId,namespace,transport:{kinds:['webrtc','webtransport']}}})
    return {socket,events}
  }
  t.after(()=>{for(const socket of all)socket.close()})
  const variants=[base,{...base,network:createNetwork(otherAppId,'public')},{...base,network:createNetwork(PEERNET_APP_ID,'private')},{...base,protocolVersion:'v2'}, {...base,chainId:'lfc:first'}, {...base,chainId:'lfc:second'}]
  const pairs=[]
  for(const scope of variants) pairs.push([await connect('same-a',scope),await connect('same-b',scope)])
  await tick()
  assert.equal(server.namespaces.length,variants.length)
  assert.throws(()=>server.peers,/Ambiguous/)
  assert.throws(()=>server.sendToPeer('same-b',{bad:true}),/Ambiguous/)
  for(let index=0;index<pairs.length;index++) {
    const [a,b]=pairs[index], scope=variants[index]
    assert.equal((await a.socket.request({url:'peers'})).length,2)
    assert.ok(a.events.filter(event=>event.topic==='peer:joined').every(event=>namespaceKey(event.value.namespace)===namespaceKey(scope)))
    assert.equal(server.peersFor(scope).size,2)
    a.socket.send({url:'signal',params:{from:'same-a',to:'same-b',version:scope.protocolVersion,channelName:`scope-${index}`,signal:{sdp:'test-only'}}})
    a.socket.send({url:'circuit',params:{from:'same-a',to:'same-b',id:`scope-${index}`,phase:'request',method:'test',data:new Uint8Array([index,9])}})
    const {ticket}=await a.socket.request({url:'webtransport-ticket',params:{from:'same-a',to:'same-b'}})
    assert.equal(new RelayTickets(secret).consume(ticket).scope,'v3:'+namespaceKey(scope))
    server.sendToPeer('same-b',{scope:index},'server:data',scope)
    await until(()=>b.events.some(event=>event.topic==='server:data'))
    assert.deepEqual(b.events.filter(event=>event.topic==='signal').map(event=>event.value.channelName),[`scope-${index}`])
    assert.deepEqual(b.events.filter(event=>event.topic==='circuit').map(event=>event.value.data),[new Uint8Array([index,9])])
    assert.deepEqual(b.events.filter(event=>event.topic==='server:data').map(event=>event.value),[{scope:index}])
  }
  const evil=await connect('evil',base), destination=pairs[0][1]
  evil.socket.send({url:'signal',params:{from:'same-a',to:'same-b',version:'v1',channelName:'forged',signal:{}}})
  evil.socket.send({url:'circuit',params:{from:'same-a',to:'same-b',id:'forged',phase:'request',method:'test'}})
  evil.socket.send({url:'leave',params:'same-b'})
  await assert.rejects(evil.socket.request({url:'webtransport-ticket',params:{from:'same-a',to:'same-b'}}))
  await assert.rejects(evil.socket.request({url:'join',params:{peerId:'evil',namespace:variants[1]}}))
  await assert.rejects(evil.socket.request({url:'join',params:{peerId:'evil',version:'v1',namespace:base}}))
  await assert.rejects(evil.socket.request({url:'pubsub',params:{topic:'global',subscribe:true}},500))
  await assert.rejects(evil.socket.request({url:'peernet',params:{peers:true}},500))
  const stray=await new StarConnection(url).init(); all.push(stray)
  await assert.rejects(stray.request({url:'peers'}))
  await assert.rejects(stray.request({url:'join',params:{peerId:'same-a',namespace:base}}))
  await tick()
  assert.equal(destination.socket.connectionState(),'open')
  assert.equal(destination.events.some(event=>event.value?.channelName==='forged'||event.value?.id==='forged'),false)
  assert.equal(server.peersFor(base).size,3)
  for(const socket of all)socket.close()
  await until(()=>server.namespaces.length===0)
})

test('registration limits reclaim empty groups and version changes cannot move a live socket', {timeout:8000}, async t=>{
  const server=new Server(0,'peach',{maxNamespaces:1,maxPeersPerNamespace:1,legacy:false});await server.ready;t.after(()=>server.close())
  const url=`ws://127.0.0.1:${server.address().port}`
  const a=await new StarConnection(url).init(),b=await new StarConnection(url).init();t.after(()=>{a.close();b.close()})
  await a.request({url:'join',params:{peerId:'a',namespace:base}})
  await assert.rejects(b.request({url:'join',params:{peerId:'b',namespace:base}}))
  const otherNetwork = createNetwork(PEERNET_APP_ID,'other')
  await assert.rejects(b.request({url:'join',params:{peerId:'b',namespace:{...base,network:otherNetwork}}}))
  await assert.rejects(a.request({url:'join',params:{peerId:'a',namespace:{...base,protocolVersion:'v2'}}}))
  a.close();await until(()=>server.namespaces.length===0)
  await b.request({url:'join',params:{peerId:'b',namespace:{...base,network:otherNetwork}}})
  assert.equal(server.namespaces.length,1)
})

test('real SDK clients automatically register and exchange binary circuits only inside their namespace', {timeout:15000},async t=>{
  const server=new Server(0,'peach');await server.ready
  const root=process.env.PEERNET_TEST_ENTRY ? await mkdtemp(join(tmpdir(),'star-peernet-namespace-')) : undefined
  const children=[];t.after(async()=>{
    await Promise.all(children.filter(child=>child.exitCode===null&&child.signalCode===null).map(child=>{const exited=once(child,'exit');child.kill();return exited}))
    await server.close();if(root)await rm(root,{recursive:true,force:true})
  })
  async function child(peerId,scope){
    const process=fork(new URL(root ? './peernet-namespace-client.js' : './namespace-client.js',import.meta.url),[],{env:{...globalThis.process.env,
      ...(root ? {PEERNET_TEST_ROOT:join(root,String(children.length))} : {}),
      STAR_TEST_URL:`ws://127.0.0.1:${server.address().port}`,STAR_TEST_PEER:peerId,STAR_TEST_SCOPE:JSON.stringify(scope)},stdio:['ignore','pipe','pipe','ipc']})
    children.push(process)
    const pending=new Map();let next=0,output=''
    process.stderr.on('data',chunk=>output+=chunk)
    const ready=new Promise((resolve,reject)=>{
      process.on('message',message=>{if(message.ready)resolve();else {const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(Error(message.error)):task.resolve(message.value)}}})
      process.on('exit',code=>reject(Error(`SDK child exited ${code}: ${output}`)))
    })
    await ready
    return {call:(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});process.send({id,method,params})})}
  }
  const a=await child('a',base),b=await child('b',base),other=await child('b',{...base,network:createNetwork(otherAppId,'public')})
  assert.deepEqual(await a.call('echo',{peer:'b'}),[1,7,255])
  assert.deepEqual(await a.call('echo',{peer:'b',size:200000}),{length:200000,first:77,last:77})
  await assert.rejects(other.call('echo',{peer:'a'}),/namespace|unavailable|not found/)
  assert.equal(server.peersFor(base).size,2)
  assert.equal(server.peersFor({...base,network:createNetwork(otherAppId,'public')}).size,1)
})

test('real Peernet reuses the same wallet after a restart with a different app ID and wire version',{
  skip:!process.env.PEERNET_TEST_ENTRY,timeout:15000
},async t=>{
  const server=new Server(0);await server.ready;t.after(()=>server.close())
  const root=await mkdtemp(join(tmpdir(),'peernet-stable-wallet-'));t.after(()=>rm(root,{recursive:true,force:true}))
  async function boot(scope,reuse){
    const child=fork(new URL('./peernet-namespace-client.js',import.meta.url),[],{env:{...process.env,
      STAR_TEST_URL:`ws://127.0.0.1:${server.address().port}`,STAR_TEST_PEER:'same-node',STAR_TEST_SCOPE:JSON.stringify(scope),
      PEERNET_TEST_ROOT:root,TEST_WALLET_NETWORK:'leofcoin:peach',TEST_REUSE_IDENTITY:reuse?'1':'0'},stdio:['ignore','pipe','pipe','ipc']})
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited}})
    let errors='';child.stderr.on('data',chunk=>errors+=chunk)
    const ready=await new Promise((resolve,reject)=>{child.on('message',value=>{if(value.ready)resolve(value)});child.on('exit',code=>reject(Error(`Wallet child exited ${code}: ${errors}`)))})
    const exited=once(child,'exit');child.kill();await exited;await until(()=>server.namespaces.length===0)
    return ready
  }
  const before=await boot(base,false)
  const after=await boot({...base,network:createNetwork(otherAppId,'public'),protocolVersion:'v2'},true)
  assert.equal(after.account,before.account)
  assert.equal(after.walletId,before.walletId)
  assert.equal(after.identityNetwork,'leofcoin:peach')
  assert.notDeepEqual(after.namespace,before.namespace)
})

test('legacy environments are discovered automatically but never mixed with v3 or another legacy network/version', {timeout:8000},async t=>{
  const server=new Server(0);await server.ready;t.after(()=>server.close())
  const sockets=[];t.after(()=>{for(const socket of sockets)socket.close()})
  const url=`ws://127.0.0.1:${server.address().port}`
  async function legacy(protocol,version){
    const socket=new WebSocket(url,protocol),messages=[];sockets.push(socket)
    socket.onmessage=event=>messages.push(JSON.parse(event.data))
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
    socket.send(JSON.stringify({url:'join',id:'join',params:{peerId:'same',version}}))
    await until(()=>messages.some(message=>message.id==='join'))
    socket.send(JSON.stringify({url:'peers',id:'peers'}));await until(()=>messages.some(message=>message.id==='peers'))
    assert.equal(messages.find(message=>message.id==='peers').value.length,1)
    return {socket,messages}
  }
  const a=await legacy('peach','v1'),b=await legacy('mainnet','v1'),c=await legacy('peach','v2')
  const modern=await new StarConnection(url).init();sockets.push(modern)
  await modern.request({url:'join',params:{peerId:'same',namespace:base}})
  assert.equal(server.namespaces.length,4)
  assert.equal((await modern.request({url:'peers'})).length,1)
  a.socket.send(JSON.stringify({url:'join',id:'switch',params:{peerId:'same',version:'v1',namespace:base}}))
  await until(()=>a.messages.some(message=>message.id==='switch'))
  assert.equal(a.messages.find(message=>message.id==='switch').status,400)
  assert.equal(b.messages.filter(message=>message.url==='peer:joined').length,1)
})

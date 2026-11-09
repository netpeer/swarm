import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join,sep} from 'node:path'
import {spawn,fork} from 'node:child_process'
import {once} from 'node:events'
import Server from '../exports/server.js'
import { createNetwork, PEERNET_APP_ID } from '../exports/namespace.js'

test(`native browser ${process.env.PEERNET_BROWSER_DIR ? 'Peernet' : 'Swarm'} registers automatically and preserves binary circuit bytes without a chain ID`,{
  skip:!process.env.CHROME_BIN,timeout:20000
},async t=>{
  const star=new Server(0);await star.ready;t.after(()=>star.close())
  const namespace={network:createNetwork(PEERNET_APP_ID,'public'),protocolVersion:'file-wire-1'}
  const starURL=`ws://127.0.0.1:${star.address().port}`
  const node=fork(new URL('./namespace-client.js',import.meta.url),[],{env:{...process.env,STAR_TEST_PEER:'node',STAR_TEST_URL:starURL,STAR_TEST_SCOPE:JSON.stringify(namespace)},stdio:['ignore','pipe','pipe','ipc']})
  t.after(async()=>{if(node.exitCode===null&&node.signalCode===null){const closed=once(node,'exit');node.kill();await closed}})
  await new Promise((resolve,reject)=>{node.on('message',message=>{if(message.ready)resolve()});node.on('exit',()=>reject(Error('Node fixture failed')))})
  const root=resolve(process.env.PEERNET_BROWSER_DIR || 'exports/browser')
  const http=createServer(async(request,response)=>{
    try{const pathname=new URL(request.url,'http://localhost').pathname;
      if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Isolated Swarm test</title>');return}
      const path=resolve(root,pathname.slice(1));
      if(!path.startsWith(root+sep)){response.writeHead(403).end();return}
      response.setHeader('Content-Type','text/javascript');response.end(await readFile(path))
    }catch{response.writeHead(404).end()}
  }).listen(0,'127.0.0.1')
  await once(http,'listening');t.after(()=>{http.closeAllConnections();http.close()})
  const profile=await mkdtemp(join(tmpdir(),'swarm-namespace-chrome-'))
  const chrome=spawn(process.env.CHROME_BIN,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']})
  t.after(async()=>{if(chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill();await exited}await rm(profile,{recursive:true,force:true})})
  const endpoint=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),5000)
    chrome.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1])}});chrome.on('error',reject)})
  const targets=await(await fetch(`${endpoint.replace('ws:','http:').split('/devtools/')[0]}/json/list`)).json()
  const socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);await once(socket,'open');t.after(()=>socket.close())
  let next=0,onPageLoaded;const tasks=new Map()
  socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.method==='Page.loadEventFired')onPageLoaded?.();if(value.id){const task=tasks.get(value.id);tasks.delete(value.id);value.error?task.reject(Error(value.error.message)):task.resolve(value.result)}}
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next;tasks.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})
  await call('Page.enable',{})
  const loaded=new Promise(resolve=>{onPageLoaded=resolve})
  await call('Page.navigate',{url:`http://127.0.0.1:${http.address().port}/`})
  await loaded
  const result=await call('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
    const {default:SDK}=await import('http://127.0.0.1:${http.address().port}/${process.env.PEERNET_BROWSER_DIR ? 'peernet' : 'client'}.js');
    const scope=${JSON.stringify(namespace)};
    const makeClient=async network=>{
      const transport={kinds:['webtransport'],fallback:{order:['circuit'],connectTimeoutMs:500}};
      if(${Boolean(process.env.PEERNET_BROWSER_DIR)}){
        const node=await new SDK({network,protocolVersion:scope.protocolVersion,
          routingId:'browser',root:'namespace-test-'+network.replaceAll(':','-'),freshIdentity:true,autoStart:false,stars:[${JSON.stringify(starURL)}],transport},'isolated-browser-test-only');
        await node.start();return node.client;
      }
      return new SDK({peerId:'browser',...scope,network,stars:[${JSON.stringify(starURL)}],transport,retry:{retries:0}});
    };
    const client=await makeClient(scope.network);
    await client.ready;
    const data=await client.circuitRequest('node','test:echo',new Uint8Array(200000).fill(91),2000);
    const okay=data instanceof Uint8Array&&data.length===200000&&data[0]===91&&data.at(-1)===91;
    await client.close();
    const other=await makeClient(${JSON.stringify(createNetwork('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','public'))});
    await other.ready;let blocked=false;try{await other.circuitRequest('node','test:echo',new Uint8Array([1]),1000)}catch{blocked=true}
    await other.close();return {okay,blocked,noChainId:!Object.hasOwn(client.namespace,'chainId')};
  })()`})
  assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails))
  assert.deepEqual(result.result.value,{okay:true,blocked:true,noChainId:true})
})

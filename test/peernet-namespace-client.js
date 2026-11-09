// Real Peernet runtime with an isolated temporary wallet/store, never an existing account.
import { pathToFileURL } from 'node:url'
import { relative } from 'node:path'
import { homedir } from 'node:os'
const {default:Peernet}=await import(pathToFileURL(process.env.PEERNET_TEST_ENTRY).href)
const scope=JSON.parse(process.env.STAR_TEST_SCOPE)
const identity = process.env.TEST_WALLET_NETWORK ? new (await import(new URL('./identity.js',pathToFileURL(process.env.PEERNET_TEST_ENTRY)))).default(process.env.TEST_WALLET_NETWORK) : undefined
const node=await new Peernet({...scope,
  ...(identity ? {identity} : {}),
  routingId:process.env.STAR_TEST_PEER,stars:[process.env.STAR_TEST_URL],root:relative(homedir(),process.env.PEERNET_TEST_ROOT),
  freshIdentity:process.env.TEST_REUSE_IDENTITY !== '1',autoStart:false,transport:{kinds:['webtransport'],fallback:{order:['circuit'],connectTimeoutMs:500}}},'isolated-namespace-test-only')
const identityBefore=node.selectedAccount
await node.start()
node.client.onCircuit('test:echo',value=>value)
if(identityBefore!==node.selectedAccount)throw Error('Discovery changed wallet identity')
process.send({ready:true,namespace:node.namespace,account:node.selectedAccount,walletId:node.peerId,identityNetwork:node.identity.network})
process.on('message',async message=>{
  try{
    const value=await node.client.circuitRequest(message.params.peer,'test:echo',message.params.size ? new Uint8Array(message.params.size).fill(77) : new Uint8Array([1,7,255]),1500)
    if(!(value instanceof Uint8Array))throw Error('Circuit did not preserve binary data')
    process.send({id:message.id,value:message.params.size ? {length:value.length,first:value[0],last:value.at(-1)} : [...value]})
  }catch(error){process.send({id:message.id,error:String(error.message)})}
})

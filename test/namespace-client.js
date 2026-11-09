import Client from '../exports/client.js'
const scope=JSON.parse(process.env.STAR_TEST_SCOPE)
const client=new Client({peerId:process.env.STAR_TEST_PEER,...scope,
  stars:[process.env.STAR_TEST_URL],transport:{kinds:['webtransport'],fallback:{order:['circuit'],connectTimeoutMs:500}},retry:{retries:0}})
client.onCircuit('test:echo',value=>value)
await client.ready
process.send({ready:true})
process.on('message',async message=>{
  try{
    const value=await client.circuitRequest(message.params.peer,'test:echo',message.params.size ? new Uint8Array(message.params.size).fill(77) : new Uint8Array([1,7,255]),1500)
    if(!(value instanceof Uint8Array))throw Error('Circuit did not preserve binary data')
    process.send({id:message.id,value:message.params.size ? {length:value.length,first:value[0],last:value.at(-1)} : [...value]})
  }catch(error){process.send({id:message.id,error:String(error.message)})}
})

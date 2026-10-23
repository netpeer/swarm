import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import websocket from 'websocket'
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const child = spawn(process.execPath, ['--input-type=module', '-e', `import Server from './exports/server.js'; new Server(${port}, 'peach', {relaySecret:'test-only-secret-with-at-least-32-bytes'});`], { stdio: ['ignore', 'pipe', 'pipe'] })
const clients = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = setTimeout(() => { child.kill(); console.error('authorization test timed out'); process.exit(1) }, 7000)
try {
  await new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { if (String(bytes).includes('listening on')) resolve() })
    child.on('exit', code => reject(new Error(`star exited ${code}`)))
  })
  const connect = async () => {
    const socket = new websocket.w3cwebsocket(`ws://127.0.0.1:${port}`, 'peach')
    const messages = []
    socket.onmessage = ({ data }) => messages.push(JSON.parse(data))
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    clients.push(socket)
    return { socket, messages, send: (url, params, id) => socket.send(JSON.stringify({ url, params, id })) }
  }
  const a = await connect(), b = await connect(), attacker = await connect()
  const join = (client, peerId) => client.send('join', { peerId, version: '0.4.0', transport: { kind: 'webtransport', kinds: ['webtransport'] } })
  join(a, 'a'); join(b, 'b'); join(attacker, 'evil')
  await delay(50)
  attacker.send('circuit', { from: 'a', to: 'b', id: 'forged', phase: 'request', method: 'echo' })
  attacker.send('leave', 'b')
  attacker.send('webtransport-ticket', { from: 'a', to: 'b' }, 'bad-ticket')
  a.send('webtransport-ticket', { from: 'a', to: 'b' }, 'good-ticket')
  a.send('circuit', { from: 'a', to: 'b', id: 'valid', phase: 'request', method: 'echo' })
  await delay(100)
  assert.equal(b.socket.readyState, 1)
  assert.ok(!b.messages.some(message => message.value?.id === 'forged'))
  assert.ok(b.messages.some(message => message.value?.id === 'valid'))
  assert.ok(attacker.messages.find(message => message.id === 'bad-ticket')?.value.error)
  assert.equal(typeof a.messages.find(message => message.id === 'good-ticket')?.value.ticket, 'string')
  // An active peer ID must not be taken over by a second connection.
  join(attacker, 'a')
  await delay(20)
  a.send('circuit', { from: 'a', to: 'b', id: 'still-valid', phase: 'request', method: 'echo' })
  await delay(50)
  assert.ok(b.messages.some(message => message.value?.id === 'still-valid'))
  console.log('PASS: live star rejects forged sender, unauthorized ticket, leave and duplicate identity')
} finally {
  clearTimeout(deadline)
  for (const socket of clients) socket.close()
  child.kill()
}

import Client from '../exports/client.js'
import { setStart, getElapsed } from './time.js'

globalThis.DEBUG = true

const client = new Client({
  peerId: 'peer-large-1',
  networkVersion: 'peach',
  version: 1,
  stars: ['ws://localhost:44444']
})

const sizeMB = Number(process.env.SIZE_MB ?? 128)
const bytes = sizeMB * 1024 * 1024
const message = new Uint8Array(bytes)

for (let i = 0; i < message.length; i++) message[i] = i % 256

pubsub.subscribe('peer:connected', async (peerId) => {
  if (peerId !== 'peer-large-2') return
  console.log('connected: ' + peerId)
  const peer = client.getPeer(peerId)
  try {
    setStart()
    peer.send(message, 'big')
  } catch (e) {
    console.error('request failed:', e)
  }
})

pubsub.subscribe('peer:data', ({ from, id, data }) => {
  if (id === 'big') {
    const ms = getElapsed()
    const seconds = ms / 1000
    const mib = bytes / (1024 * 1024)
    const mb = bytes / 1_000_000
    const mibps = (mib / seconds).toFixed(2)
    const mbps = (mb / seconds).toFixed(2)
    console.log(
      `sent ${bytes} bytes in ${ms}ms => ${mibps} MiB/s (${mbps} MB/s)`
    )
    const peer = client.getPeer('peer-large-2')
    setStart()
    peer.send(message, 'big')
  }
})

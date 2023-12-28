import { spawn, spawnSync } from 'child_process'

const server = spawn('node ./test/server.js', { shell: true })

server.stderr.on('data', (data) => {
  console.log(data.toString())
})

server.stdout.on('data', (data) => {
  console.log(data.toString())
})

const client = spawn('node ./test/client.js', { shell: true })
client.stderr.on('data', (data) => {
  console.log(data.toString())
})
client.stdout.on('data', (data) => {
  console.log(data.toString())
})
setTimeout(() => {
  const client2 = spawn('node ./test/client-2.js', { shell: true })
  client2.stderr.on('data', (data) => {
    console.log(data.toString())
  })
  client2.stdout.on('data', (data) => {
    console.log(data.toString())
  })
}, 1000)

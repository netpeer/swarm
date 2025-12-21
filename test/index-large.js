import { spawn } from 'child_process'

const server = spawn('node ./test/server.js', { shell: true })

server.stderr.on('data', (data) => {
  console.log(data.toString())
})

server.stdout.on('data', (data) => {
  console.log(data.toString())
})

const client1 = spawn('node ./test/client-large-1.js', { shell: true })
client1.stderr.on('data', (data) => {
  console.log(data.toString())
})
client1.stdout.on('data', (data) => {
  console.log(data.toString())
})

setTimeout(() => {
  const client2 = spawn('node ./test/client-large-2.js', { shell: true })
  client2.stderr.on('data', (data) => {
    console.log(data.toString())
  })
  client2.stdout.on('data', (data) => {
    console.log(data.toString())
  })
}, 1000)

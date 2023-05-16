import Server from './exports/server.js'
const args = process.argv0

let network
let port
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--network') network = args[i + 1]
  if (args[i] === '--port') port = args[i + 1]
}
new Server(port, network)
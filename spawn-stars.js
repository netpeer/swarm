const {spawn} = await import('child_process')

const networks = [{
  network: 'leofcoin:peach',
  networkVersion: 'peach',
  port: 44444
}]


for (const {port, network} of networks) {
  spawn('node', ['./spawn-star.js', '--port', port, '--network', network])
}

import Client from '../exports/client.js'
;(async () => {
  console.log('starting reinit-backoff test')

  const client = await new Client({
    peerId: 'test-peer',
    networkVersion: 'peach',
    version: 1,
    stars: ['wss://fake.leofcoin.org'],
    retry: { retries: 5, factor: 2, minTimeout: 10, maxTimeout: 100 }
  })

  // wait a short while to let setupStar retries finish
  await new Promise((r) => setTimeout(r, 500))

  const attempts = client.attempts()
  console.log('socket-request-client init attempts:', attempts)

  if (attempts >= 3) {
    console.log('PASS: backoff retried and eventually connected')
    process.exit(0)
  } else {
    console.error('FAIL: expected >=3 attempts, got', attempts)
    process.exit(1)
  }
})()

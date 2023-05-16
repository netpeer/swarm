# @netpeer/swarm
> peer discoverer client & server


## usage
### server
```js
import {Server} from '@netpeer/swarm'

const network = 'netpeer:peach'
const port = 44444

new Server(port, network)

```

### client
```js
import {Client} from '@netpeer/swarm'

const stars = ['wss://peach.netpeer.org']
const networkVersion = 'peach'
// wrtc object is added into glabalSpace
new Client(id, networkVersion, stars)

```

#### browser
```js
import {Client} from '@netpeer/swarm/dist/client.browser.js'

// wrtc object is added into glabalSpace
new Client(id, networkVersion, stars)

```

## examples
events
```js
const client = new Client(id, networkVersion, stars)
// events exposed to pubsub
pubsub.subscribe('peer:data' data => console.log(data))
pubsub.subscribe('peer:joined', peer => console.log(peer))
pubsub.subscribe('peer:left', peer => console.log(peer))
pubsub.subscribe('peer:connected', peer => console.log(peer))
peernet.subscribe('shard', async message => console.log(message) // {id, data, size}
// const finished = await _handleMessage()
```

properties
```js
const client = new Client(id, network)
client.id
client.connection
client.connections // object {id: connection}

```

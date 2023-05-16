const Client = require('./../dist/commonjs/client');
const Server = require('./../dist/commonjs/server');

globalThis.DEBUG = true
const server = new Server().then(() => new Client())
pubsub.subscribe('peer:data', (data) => console.log(new TextDecoder().decode(data.data)))

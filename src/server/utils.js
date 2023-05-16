import socketResponse from 'socket-request-server/response'

/**
 * @params {String} event - name of the pubsub.subscribtion (peer:left||peer:joined)
 * @params {String} data - peer id
 * @params {String} connection - peer connection
 */
export const sendPubSubMessage = (event, data, connection) => {
  socketResponse(connection, 'pubsub', event).send(data)
}

/**
 * @params {String} event - name of the pubsub.subscribtion (peer:left||peer:joined)
 * @params {String} data - peer id
 * @params {Object} peers - peerset to broadcast todo
 */
export const broadcastPubSubMessage = (event, data, peers) => {
  for (const connection of Object.values(peers)) {
    socketResponse(connection, 'pubsub', event).send(data)
  }
}

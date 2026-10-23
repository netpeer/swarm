import typescript from '@rollup/plugin-typescript'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'

export default [
  {
    input: [
      'src/server/server.ts',
      'src/server/webtransport-relay.js',
      'src/server/relay-tickets.js',
      'src/transport-frames.js',
      'src/client/circuit-peer.ts',
      'src/client/webtransport-peer.ts',
      'src/client/client.ts',
      'src/client/peer.ts'
    ],
    output: [
      {
        dir: './exports',
        format: 'es'
      }
    ],
    plugins: [typescript()],
    external: [
      'socket-request-server',
      'socket-request-client',
      '@koush/wrtc',
      '@vandeurenglenn/wrtc',
      '@fails-components/webtransport',
      '@vandeurenglenn/debug',
      'pako',
      'websocket',
      'node:crypto',
      'node:http'
    ]
  },
  {
    input: ['src/client/client.ts'],
    output: [
      {
        dir: './exports/browser',
        format: 'es'
      }
    ],
    external: ['@koush/wrtc', '@vandeurenglenn/wrtc', '@fails-components/webtransport', 'websocket'],
    plugins: [
      typescript({
        compilerOptions: {
          outDir: './exports/browser',
          declaration: false
        }
      }),
      json(),
      nodeResolve({
        mainFields: ['module']
      })
    ]
  }
]

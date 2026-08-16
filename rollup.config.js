import typescript from '@rollup/plugin-typescript'
import json from '@rollup/plugin-json'
import rimraf from 'rimraf'
import nodeResolve from '@rollup/plugin-node-resolve'

try {
  rimraf.sync('./exports/*.js')
} catch (e) {
  console.log('nothing to clean')
}

export default [
  {
    input: [
      'src/server/server.ts',
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
      '@vandeurenglenn/debug',
      'pako',
      'websocket'
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
    external: ['@koush/wrtc', '@vandeurenglenn/wrtc', 'websocket'],
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

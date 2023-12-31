import modify from 'rollup-plugin-modify'
import typescript from '@rollup/plugin-typescript'
import json from '@rollup/plugin-json'
import rimraf from 'rimraf'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { readFile } from 'fs/promises'

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
    plugins: [typescript()]
  },
  {
    input: ['src/client/client.ts'],
    output: [
      {
        dir: './exports/browser',
        format: 'es'
      }
    ],
    external: ['simple-peer', '@koush/wrtc'],
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
      }),
      modify({
        "import SimplePeer from 'simple-peer'": (
          await readFile('./node_modules/simple-peer/simplepeer.min.js')
        ).toString()
      })
    ]
  }
]

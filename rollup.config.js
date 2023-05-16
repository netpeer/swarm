import modify from 'rollup-plugin-modify';
import typescript from '@rollup/plugin-typescript';
import rimraf from 'rimraf';
import nodeResolve from '@rollup/plugin-node-resolve';
import tsconfig from './tsconfig.json' assert { type: 'json'};

try {
  rimraf('rm ./dist/*.js')
} catch (e) {
  console.log('nothing to clean');
};

export default  [{
  input: ['src/index.ts', 'src/server/server.ts', 'src/client/client.ts'],
  output: [{
    dir: './exports',
    format: 'es'
  }],
  plugins: [
    typescript(tsconfig)
  ]
}]

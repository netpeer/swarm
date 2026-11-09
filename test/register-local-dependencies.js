import { registerHooks } from 'node:module'
import { resolve } from './local-dependencies-loader.js'
registerHooks({resolve})

// Opt-in cross-repository verification only; published packages never load this.
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { dirname, join } from 'node:path'
export function resolve(specifier, context, nextResolve) {
  if (process.env.PEERNET_LOCAL_PEERNET_DIR && (specifier === '@leofcoin/peernet' || specifier.startsWith('@leofcoin/peernet/'))) {
    const subpath = specifier.slice('@leofcoin/peernet/'.length)
    const file = specifier === '@leofcoin/peernet' ? 'peernet.js' :
      subpath === 'browser' || subpath === 'browser.js' ? 'browser/peernet.js' : subpath.endsWith('.js') ? subpath : subpath + '.js'
    return nextResolve(pathToFileURL(join(resolvePath(process.env.PEERNET_LOCAL_PEERNET_DIR),file)).href,context)
  }
  if (specifier === '@netpeer/swarm/client' && process.env.PEERNET_LOCAL_SWARM)
    return nextResolve(pathToFileURL(resolvePath(process.env.PEERNET_LOCAL_SWARM)).href,context)
  if (specifier === '@netpeer/swarm/namespace' && process.env.PEERNET_LOCAL_SWARM)
    return nextResolve(pathToFileURL(join(dirname(resolvePath(process.env.PEERNET_LOCAL_SWARM)),'namespace.js')).href,context)
  return nextResolve(specifier,context)
}

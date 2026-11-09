// Persistent application identity. Never regenerate this on startup or release.
export const PEERNET_APP_ID = 'ebbc3219-1fbf-4e53-9e09-3438b130c495'
export const STAR_PROTOCOL = 'swarm-v3'
export const DISCOVERY_PROTOCOL_VERSION = 3
export type Namespace = { network: string; protocolVersion: string; chainId?: string }
const appIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Generate an app UUID once, commit it in that app, and reuse it on all nodes. */
export function createNetwork(appId: string, name: string): string {
  if (typeof appId !== 'string' || !appIdPattern.test(appId) || typeof name !== 'string' || !labelPattern.test(name))
    throw new TypeError('Network must contain a stable lowercase app UUID and a network name')
  return `${appId}:${name}`
}

export function parseNetwork(network: unknown): {appId:string;name:string} {
  if (typeof network !== 'string') throw new TypeError('Invalid application network')
  const [appId,name,...rest] = network.split(':')
  if (rest.length || createNetwork(appId,name) !== network) throw new TypeError('Invalid application network')
  return {appId,name}
}

/** Reject removed options even when an old JS caller bypasses TypeScript. */
export function assertNetworkOptions(options: object) {
  for (const name of ['protocol','networkVersion','version','discoveryNetwork'])
    if (Object.hasOwn(options,name)) throw new TypeError(`${name} was removed; use network (<stable-app-id>:<name>) and protocolVersion`)
}

/** Routing labels are not authentication or proof of chain membership. */
export function normalizeNamespace(value: unknown): Readonly<Namespace> {
  const scope = value as Namespace
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
    Object.keys(scope).some(key => !['network','protocolVersion','chainId'].includes(key)) ||
    typeof scope.protocolVersion !== 'string' || !labelPattern.test(scope.protocolVersion) ||
    (scope.chainId !== undefined && (typeof scope.chainId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(scope.chainId))))
    throw new TypeError('Invalid Star network namespace')
  parseNetwork(scope.network)
  return Object.freeze({network:scope.network,protocolVersion:scope.protocolVersion,
    ...(scope.chainId === undefined ? {} : {chainId:scope.chainId})})
}

export function namespaceKey(value: unknown) {
  const scope = normalizeNamespace(value)
  return JSON.stringify([scope.network,scope.protocolVersion,scope.chainId ?? null])
}

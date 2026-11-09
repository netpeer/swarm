# One Star, multiple independent networks

Star groups connections automatically by the registration supplied by Peernet:
`network`, `protocolVersion` and an optional genesis-bound `chainId`. There is no
network allowlist, protocol list or per-network Star configuration. Start the
hosted Star normally with `npm start`; `SWARM_NETWORK` no longer selects a mesh.
Existing TLS, public DNS, UDP firewall and relay-secret requirements are unchanged.

## Application configuration

```js
import Peernet, { createNetwork } from '@leofcoin/peernet'
import { APP_ID } from './app-id.js' // one UUID, committed in this application

const node = await new Peernet({
  network: createNetwork(APP_ID, 'public'),
  protocolVersion: 'file-wire-1',
  stars: ['wss://star.leofcoin.org']
}, password)
```

The network format is `<stable-app-uuid>:<network-name>`. Generate a random v4
UUID **once** when creating an app (`node -e 'console.log(crypto.randomUUID())'`)
and commit it in that app. All its nodes and releases reuse that exact ID. Never
derive it from an editable display name, npm version, wallet, node ID or startup.
Independent apps must create their own ID, even if both use the name `public`.
Network names are case-sensitive ASCII labels, at most 64 characters.

The built-in Peernet app ID is exported as `PEERNET_APP_ID`; its default mesh is
`createNetwork(PEERNET_APP_ID, 'public')`. Custom apps use their own ID. The default
wire version is `v1`, independent of npm versions. No chain ID is needed for
filesharing. Removed options `protocol`, `networkVersion`, `version` and
`discoveryNetwork` throw actionable errors instead of being silently ignored.

The Leofcoin chain wrapper supplies its own fixed app UUID, its chain protocol
version and the chain ID derived from bundled genesis, before transport starts.
It retains its existing ledger network/signature domain, wallet provider and
storage root. This routing change does not regenerate
genesis, replace wallet or validator accounts, or delete any stores. Generic
Peernet identity no longer derives from the discovery label: it defaults to a
Leofcoin wallet, or accepts an existing `identity` provider. Its default storage
root is `.peernet/<app-id>/<network-name>`; supply the existing `root` and wallet
provider when upgrading a standalone app that already has stored identities.

## Isolation and trust

Discovery, peer snapshots, join/leave events, WebRTC signaling, circuit forwarding
and relay-ticket issuance stay inside the exact registered group. Optional
`chainId` absence is distinct from every concrete chain ID. Identical peer IDs
may exist in different groups, but cannot replace an active connection in the
same group. Registration cannot change peer ID or scope on a live socket;
close and reconnect to change networks.

WebTransport tickets bind the complete group key. Reverse relay sessions pair
only inside that scope, even when both groups have identical peer IDs and
versions. Operator push/request APIs require an explicit scope when more than
one group exists; they never silently pick a network. SDK server-data callbacks
are instance-local, not a global cross-application bus.

UUIDs avoid accidental app-name collisions. They are routing boundaries, **not authentication or private-network
access control**. Any client may claim a public label or unused peer ID. Peers
must still authenticate identities, authorize application operations and verify
chain/genesis/consensus data. Resource limits do not constitute a full abuse policy.

## Wire format and compatibility

Updated SDKs negotiate WebSocket subprotocol `swarm-v3` and exchange binary
`@leofcoin/binary` envelopes. Uint8Array circuit payloads stay bytes rather than
expanding into JSON number arrays. There is no automatic downgrade.

For a rolling deployment, Star also accepts legacy environment subprotocols as
separate legacy groups keyed by the actual WebSocket subprotocol and old version.
They never mix with `swarm-v3` or another legacy environment/version. Old peers
cannot use the new namespace field to escape their legacy group. The legacy
JSON lane does not provide application-ID or chain-ID selection. The intermediate
unpublished `swarm-v2` layout is rejected; it is not silently reinterpreted.

Default bounds: 1 MiB per Star message, 128 active groups, 512 peers per group,
4096 sockets, 10 seconds for registration, 128 pending SDK socket requests and
512 operator circuit requests. Empty groups are reclaimed on disconnect.

## Rollout

1. Review and publish the compatible Swarm release; deploy the updated Star.
2. Update Peernet's minimum Swarm dependency to that published release, rebuild
   both browser and Node artifacts, and publish Peernet.
3. Update the chain's Peernet minimum and lockfile, rebuild and deploy clients.

The source changes alone are not a release: dependency minimums must be advanced
to the actual compatible published versions before shipping. Peernet's build and
runtime guards reject old unscoped Swarm, and chain rejects old Peernet. Do not
remove those guards to work around an incomplete deployment. Updated clients
will not discover old clients; upgrade all participants of a mesh together.

## Verification

```sh
npm run build
node --test test/namespaces.test.js test/transport.test.js test/peer-announcement.test.js
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test test/browser-namespace.test.js
```

Cross-repository development before publication (no published dependency overrides):

```sh
# In peernet, after building Swarm:
PEERNET_LOCAL_SWARM_DIR=../swarm/exports npm run build
PEERNET_LOCAL_SWARM=../swarm/exports/client.js node --import ../swarm/test/register-local-dependencies.js --test test/discovery-options.test.js

# Back in swarm: real Peernet processes, temporary wallets/stores only.
PEERNET_TEST_ENTRY=../peernet/exports/peernet.js PEERNET_LOCAL_SWARM=./exports/client.js node --import ./test/register-local-dependencies.js --test --test-name-pattern='real SDK|real Peernet' test/namespaces.test.js
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' PEERNET_BROWSER_DIR=../peernet/exports/browser node --test test/browser-namespace.test.js
```

The relay unit tests use in-memory streams, not a real HTTP/3 path. Run the
existing HTTP/3/automatic-relay tests separately before deploying relay changes.

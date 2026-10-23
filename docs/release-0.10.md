# Automatic transport rollout

This branch prepares `@netpeer/swarm@0.10.0`. It contains the already published
0.9.12 native-backend changes from PR #5; merge that PR first so main does not
regress to the older backend. Then merge this transport PR and publish 0.10.0.
No workflow in this change automatically publishes to npm.

`npm pack`/`npm publish` rebuild the Node and browser bundles and run the focused
transport/configuration tests through `prepack`. CI also verifies real HTTP3,
automatic startup, peer discovery, circuit fallback, and authorization. Node
requires version 24.15 or later, matching the Leofcoin launcher/native backend.

## Dependency sequence

1. Publish swarm **0.10.0** from this revision after review and CI.
2. Verify the registry really serves that version and its platform dependencies.
3. In `leofcoin/peernet`, raise the swarm dependency from `^0.9.12` to `^0.10.0`,
   generate its lockfile from the real registry, run the peernet tests with the
   new transport, and publish the next reviewed peernet release.
4. In `leofcoin/monorepo`, raise chain's peernet minimum to that published release,
   regenerate the lockfile, rebuild and test the core/launcher. Ensure the launcher
   also requires the chain/lib versions containing the intended protocol and
   generated genesis artifacts. Prepare the changed package releases, then publish
   them in dependency order using the existing release tooling.
5. Verify a fresh, standalone launch-chain installation resolves the new swarm,
   not merely that workspace builds use it. Check no Git/file overrides or local
   paths survive in published manifests or lockfiles.

Do not fabricate registry URLs/integrity hashes for unpublished versions, commit
local tarball dependencies, or claim the installed `leofcoin node` has the feature
before this entire dependency chain is published.

## Public host rollout

Upgrade both peers and the star together; old experimental WebTransport and
circuit peers without the new handshake are not compatible with the new fallback.
Do not recreate genesis or replace node identities/stores for this change.

The public star host now starts discovery and the ready QUIC relay with one
`npm start`. It creates/reuses its private secret automatically, detects a single
usable existing Let's Encrypt certificate, persists public TLS settings, and
advertises only after the relay listens. Multiple domains require one explicit
selection. Existing certificate renewal and DNS/firewall setup remain operational
prerequisites; no client has to perform those infrastructure tasks.

Normal nodes discover the relay through their configured star. Test two external
nodes through WebRTC failure and the advertised HTTP3 path before considering
public rollout successful. Then verify actual chain synchronization and finalized
transactions separately; transport fixture tests are not consensus proof.

See [host configuration](webtransport-relay.md) for defaults and manual overrides.

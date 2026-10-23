# Star and WebTransport relay

This release uses `swarm-relay/1`: one bidirectional WebTransport stream, with
each message prefixed by a four-byte unsigned big-endian payload length
(1..65536 bytes). Stream chunks are not message boundaries. The first frame is
JSON `{protocol:"swarm-relay/1",ticket}`. The relay sends a ready frame containing
the remote `peerId` and application `version` only after the reciprocal peer has
joined. Subsequent frames contain the existing PeerCore wire messages.

This is incompatible with the old unframed experimental WebTransport client and
the benchmark `/echo` service. Upgrade both peers and the star together. It does
not change chain consensus, genesis, identities, or stored blocks.

## Deployment on the same VPS

Use a dedicated DNS hostname pointing directly at this VPS, with a valid TLS
certificate for that hostname. The example `transport.example.org` below is a
placeholder, **not an existing Leofcoin endpoint**. Ordinary HTTP reverse proxying
to the node API is not a QUIC/WebTransport deployment.

No manual secret creation is required. On first startup the star or relay creates
a cryptographically random 32-byte secret (hex encoded), in a private directory
with a `0600` secret file. Both processes atomically reuse the same complete file,
even when started simultaneously. Secrets are never printed.

Default location: `~/.netpeer/swarm/network-peach/relay-secret`. This is independent
of the working directory and isolated by `SWARM_NETWORK`. Run both services under
the same service account, with the same network and data directory. Set
`SWARM_DATA_DIR` to change the data directory or `SWARM_RELAY_SECRET_FILE` to use
a specific shared file (also created automatically if missing). A malformed,
symlinked or overly permissive existing secret fails startup; it is never silently
replaced. POSIX file modes are checked on Unix; use restrictive ACLs on Windows.

Normal nodes need no relay configuration: they discover the ready endpoint from
their configured star, obtain tickets through that same connection, and fall back
from WebRTC to WebTransport or circuit. Explicit transport restrictions are still
honored. A normal node does not host public infrastructure or need TLS keys.

The **public star host** starts discovery and its relay together with one command:

```sh
npm start
```

The host automatically finds a single matching, valid Let's Encrypt certificate
under `/etc/letsencrypt/live`, starts QUIC, and only then advertises its endpoint.
Hostname and certificate paths are saved in the private network directory as
`relay-settings.json` after successful startup. Later starts reuse those settings.
When several domains exist, select the intended one once:

```sh
SWARM_WT_HOSTNAME=transport.example.org npm start
```

With a selected hostname, the relay automatically loads existing Let's Encrypt files from
`/etc/letsencrypt/live/<hostname>/fullchain.pem` and `privkey.pem`. Alternatively
set `SWARM_WT_CERT_FILE` and `SWARM_WT_KEY_FILE` on first startup. A valid domain/certificate must
already exist: the software does not change DNS, obtain ACME certificates or
substitute an untrusted self-signed certificate. For a custom `SWARM_NETWORK`,
set it on the single host process. Default ports are star TCP 44444 and relay
UDP 4433; override with `SWARM_PORT` and `SWARM_WT_PORT` when needed.

The relay needs **UDP 4433** reachable through the host and provider firewalls.
Do not expose private keys or the shared ticket secret. Restrict file access to
the service account. Restart/reload the relay after certificate renewal. This
implementation explicitly starts HTTP/3, not an HTTP/2 fallback. The same process
owns relay startup/shutdown and discovery. `start:webtransport` remains an advanced
standalone mode, not a requirement for normal hosting. Install optional
dependencies and permit the reviewed QUIC native package's installation script.
If its native binary is unavailable, the relay must fail startup; it must not
advertise a working endpoint.

Clients discover this configuration automatically. An optional explicit override
for specialized deployments is:

```js
transport: {
  kinds: ['webrtc', 'webtransport'],
  preferredKind: 'webrtc',
  webtransport: { urlTemplate: 'https://transport.example.org:4433/swarm' },
  fallback: { enabled: true, order: ['webrtc', 'webtransport', 'circuit'] }
}
```

Without a discovered or explicit endpoint, WebTransport is skipped and normal
WebRTC/circuit connectivity remains available. A host without TLS reports that
public WebTransport hosting is unavailable; it does not claim an HTTPS endpoint.
Browsers use their native WebTransport implementation; Node loads the
`@fails-components/webtransport` implementation lazily. The public deployment
must use trusted TLS certificates: no production certificate-verification bypass
or hardcoded test fingerprint is provided.

## Authorization and limits

Clients request a 30-second, single-use HMAC ticket through the star connection
that registered their peer ID. Tickets bind both peer IDs, the star network and
the application version. The star checks both peers and matching versions before
issuing tickets. The relay pairs only reciprocal claims. It caps sessions at 256,
replay records at 10000, frames at 64 KiB and pairing time at ten seconds.
Disconnecting one endpoint closes its partner. Additional bidirectional streams
are rejected. Writes await stream backpressure.

This binds authorization to the star's registered connection. It is **not** a
cryptographic proof of wallet ownership, validator eligibility or consensus.
Protect the star using WSS. Internet-facing deployment still needs operational
rate limiting, monitoring and capacity tuning; this is not a DDoS-proof service.

The circuit fallback now requires a reciprocal peer hello, with peer ID and
version validation and `encoding: "peer-core/1"`, before publishing
`peer:connected`. Circuit data now uses the same framed, checksummed, compressed
and chunked payload encoding as the other transports. Its smaller 14000-byte
chunks leave room for JSON expansion inside WebSocket's frame limit. Upgrade
both circuit peers together; older peers without this handshake fail explicitly.
The server refuses
forged senders, unauthorized leave requests, and replacement of an active peer
ID. Pending responses are bound to the expected peer and star connection.

## Verification

```sh
npm run build
npm run test:transport
npm run test:config
npm run test:authorization
npm run test:integration
npm run test:http3
npm run test:auto
```

`test:transport` uses in-memory streams. `test:http3` separately creates ephemeral
test TLS material and uses real loopback QUIC/HTTP3, with no HTTP2 fallback. Neither
proves public DNS/firewall reachability, browser compatibility or chain finality.
`test:auto` starts the managed host, forces WebRTC failure for two separate client
processes without transport options, verifies discovery and HTTP3 payload exchange,
then restarts the host and exercises `run-server.js` without repeating TLS options.
After deployment verify two independent external clients exchange data through
this endpoint before enabling it for all nodes.

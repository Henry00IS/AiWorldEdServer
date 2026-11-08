# Self-hosting the AiWorldEd relay

The relay is a single process with no database and no runtime dependencies. It never
stores worlds: the room owner's editor holds the world and the relay only forwards
messages between the editors in a room. Anything that can run one executable can host it.

## Run it

Pick one. Each listens on port 8081 and serves `ws://<host>:8081/ws`.

| How | Command |
| --- | --- |
| Release executable | `./aiworlded-relay-linux-x64` (or the macOS / Windows file) |
| Docker | `docker build -t aiworlded-relay . && docker run --rm -p 8081:8081 aiworlded-relay` |
| Docker Compose | `docker compose -f deploy/self-host/compose.yaml up -d` |
| From source (Bun 1.4.4) | `bun install && bun run start` |

Build the executables yourself with `bun run build:binary` (this machine, into `dist/`) or
`bun run build:release` (Linux, macOS and Windows, x64 and arm64, into `dist/release` with
a `SHA256SUMS` file). Both embed the Bun runtime, so the target needs nothing installed.
`build:release` refuses to run on a Bun other than the version pinned in `package.json`.

On start the relay prints one JSON line describing what it is doing, for example:

```json
{"event":"relay.started","protocol":2,"url":"wss://0.0.0.0:8443/ws","tls":true,"clientAddress":"socket","forwardedSecret":"unused","allowedOrigins":["https://editor.example.com"],"internalTestRooms":"off","limits":{"usersPerRoomDefault":16,"usersPerRoomMaximum":32,"roomsTotal":500,"roomsPerIp":8,"connectionsTotal":2000,"connectionsPerIp":24,"snapshotBytesMaximum":268435456},"configFile":null}
```

Risky combinations add `relay.warning` lines. An invalid setting prints a `relay.error`
line naming the variable and exits with status 1, so a typo never starts a relay with
settings you did not ask for. `GET /healthz` answers `ok` for health checks.

## Connect the editor

Open the editor with `?relay=` set to your relay's URL, for example
`https://henry00is.github.io/AiWorldEd/?relay=wss://relay.example.com/ws`. Editor builds can
also default to your relay with `VITE_COLLABORATION_SERVER_URL=wss://relay.example.com/ws`
at build time.

The page the editor is served from must be in `ALLOWED_ORIGINS`. The default list allows
the official editor, `localhost` / `127.0.0.1` / `[::1]` on any port and the desktop app. If
you serve the editor yourself, add its address (`ALLOWED_ORIGINS=https://editor.example.com`)
and keep the defaults you still need, because the variable replaces the list.
`ALLOWED_ORIGINS=*` allows every page.

When the relay refuses a connection it still completes the WebSocket handshake and then
closes with a code and reason the editor shows, instead of a bare network error:

| Code | Reason | Meaning |
| --- | --- | --- |
| 4009 | `origin not allowed: <origin>` | The editor's address is not in `ALLOWED_ORIGINS`. |
| 4010 | `proxy refused: X-Forwarded-Secret does not match` | The proxy sent the wrong `FORWARDED_SECRET`. |
| 4011 | `too many connections from your address` | `CONNECTIONS_PER_IP` reached. |
| 4005 | `server full` | `CONNECTIONS_TOTAL` reached. |

If a flood of refused connections is already waiting to close, further refusals get a plain
HTTP 403 / 429 / 503 instead.

## Settings

Every setting is an environment variable. The same names also work as keys of an optional
JSON config file, passed as `--config relay.json` or `CONFIG_FILE=relay.json`:

```json
{ "PORT": 8443, "TLS_CERT": "/etc/relay/cert.pem", "TLS_KEY": "/etc/relay/key.pem", "USERS_PER_ROOM_MAX": 64 }
```

Values may be strings, numbers, booleans or (for `ALLOWED_ORIGINS`) a list of strings.
Unknown keys are an error. Environment variables override the file, and empty values count
as unset. Booleans accept `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off`.
`bun run config:table` prints this table from the source.

| Variable | Group | Default | Accepted | Meaning |
| --- | --- | --- | --- | --- |
| `HOST` | network | 0.0.0.0 | an IP address or host name | Address to listen on; 0.0.0.0 for all IPv4 interfaces, :: for all interfaces. |
| `PORT` | network | 8081 | 0 to 65535 | TCP port to listen on (0 picks a free port). |
| `WEBSOCKET_PATH` | network | /ws | a path like /ws or /wstest | URL path of the WebSocket endpoint. |
| `TLS_CERT` | network | unset | file path | PEM certificate (full chain) file; with TLS_KEY the relay serves wss:// itself. |
| `TLS_KEY` | network | unset | file path | PEM private key file for TLS_CERT. |
| `TRUST_PROXY` | network | false | true / false | Take the client address from X-Real-IP / X-Forwarded-For. Only behind a reverse proxy. |
| `FORWARDED_SECRET` | network | unset | at least 16 characters | Optional with TRUST_PROXY: requests with a different X-Forwarded-Secret are refused. |
| `ALLOWED_ORIGINS` | security | https://henry00is.github.io,http://localhost:*,http://127.0.0.1:*,http://[::1]:*,views://main_ui | comma separated origins (`https://host`, `http://host:*` for any port, or `*` for any) | Web pages allowed to connect (the editor's address); replaces the default list. |
| `USERS_PER_ROOM_DEFAULT` | rooms | 16 | 2 to 1000 | Room size when the creator does not choose one. |
| `USERS_PER_ROOM_MAX` | rooms | 32 | 2 to 1000 | Largest room size a creator may choose. |
| `ROOMS_TOTAL` | rooms | 500 | 1 to 100000 | Rooms open at once on the whole relay. |
| `ROOMS_PER_IP` | rooms | 8 | 1 to 100000 | Rooms one address (IPv6: one /64) may own at once. |
| `LOCKS_PER_USER` | rooms | 20000 | 1 to 10000000 | Objects one member may hold locked at once. |
| `LOCKS_PER_ROOM` | rooms | 100000 | 1 to 10000000 | Objects locked at once in one room. |
| `SNAPSHOT_BYTES_MAX` | rooms | 268435456 | 1048576 to 536870912 | Largest world snapshot sent to a joining member, in bytes. |
| `ASSET_BYTES_MAX` | rooms | 67108864 | 1048576 to 536870912 | Largest single asset (texture) transfer, in bytes. |
| `SNAPSHOT_TIMEOUT_MS` | rooms | 60000 | 5000 to 3600000 | How long a joining member waits for the owner's snapshot. |
| `CONNECTIONS_TOTAL` | limits | 2000 | 1 to 100000 | Open connections on the whole relay. |
| `CONNECTIONS_PER_IP` | limits | 24 | 1 to 100000 | Open connections from one address (IPv6: one /64). |
| `ROOM_ENTRIES_PER_IP_PER_MINUTE` | limits | 30 | 1 to 100000 | Room creations and joins per address per minute. |
| `ROOM_ENTRY_BURST_PER_IP` | limits | 10 | 1 to 100000 | Room creations and joins one address may make in a burst. |
| `MAX_PAYLOAD_BYTES` | limits | 1048576 | 524288 to 67108864 | Largest single WebSocket message, in bytes. |
| `OUTBOUND_BACKLOG_BYTES_TOTAL` | limits | 268435456 | 16777216 to 68719476736 | Bytes queued for slow receivers on the whole relay; caps memory use. |
| `TRANSFER_SIZE_MAXIMUM` | limits | 104857600 | 0 to 104857600 | Largest file a transfer link serves, in bytes (at most 100 MiB). |
| `TRANSFER_DOWNLOADS_PER_OWNER` | limits | 16 | 1 to 1000 | Concurrent downloads of the transfer links of one connection. |
| `INTERNAL_TEST_ROOMS` | testing | false | true / false | Allow hidden internal test rooms for direct (non-proxied) connections. Development only. |
| `INTERNAL_TEST_ROOMS_VIA_PROXY` | testing | false | true / false | Also allow internal test rooms through the proxy. Development relay only. |

## TLS

Either let the relay terminate TLS itself, or put it behind a reverse proxy that does.

Built in: set `TLS_CERT` (PEM, full chain) and `TLS_KEY` (PEM). The relay then serves
`wss://` and `https://…/healthz` on `PORT`. A missing or unreadable file stops the relay at
start. Certificates are read once at start, so restart the relay after renewing them.
Browsers only connect to certificates they trust: use a real certificate (for example from
Let's Encrypt) for anything but local testing.

## Behind a reverse proxy

By default the relay counts connections per **socket address** and ignores
`X-Forwarded-For` / `X-Real-IP`, so nobody can dodge the per-address limits by sending fake
headers. Behind a proxy every connection would then share the proxy's address, so set
`TRUST_PROXY=true`: the relay then takes the client address from `X-Real-IP`, else the last
`X-Forwarded-For` entry.

Only enable `TRUST_PROXY` when clients cannot reach the relay port except through the
proxy (bind `HOST=127.0.0.1` or firewall it). If the port is reachable by others, also set
`FORWARDED_SECRET` and make the proxy send it as `X-Forwarded-Secret`: requests with the
right secret use the forwarded address, requests without the header are treated as direct
(socket address), and requests with a wrong secret are refused with 4010.

Caddy (obtains and renews certificates automatically):

```caddyfile
relay.example.com {
	reverse_proxy /ws* 127.0.0.1:8081 {
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-Secret {env.RELAY_FORWARDED_SECRET}
	}
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Secret "same-value-as-FORWARDED_SECRET";
        proxy_read_timeout 1h;
        proxy_buffering off;
        client_max_body_size 64m;
    }
}
```

where `$connection_upgrade` comes from
`map $http_upgrade $connection_upgrade { default upgrade; '' close; }` in the `http` block,
so plain HTTP requests reach the relay too.

with the relay started as `HOST=127.0.0.1 TRUST_PROXY=true FORWARDED_SECRET=<same value>`.
Drop the secret lines on both sides if the relay only listens on `127.0.0.1`.

## Transfer links

Editors can share files from memory through the relay: an editor asks for a link and the
relay answers plain HTTP `GET` and `HEAD` on `<WEBSOCKET_PATH>/transfer/<id>` (for example
`https://relay.example.com/ws/transfer/<id>`) by streaming the file from that editor in
256 KiB chunks, one chunk in flight per editor connection. Nothing is stored on the relay. A
link stops working when its editor disconnects, after one hour, or when the relay restarts.
Raster images, video, audio and PDF open in place, other files download; `?download` always
downloads. Single `Range` requests are answered with 206, so videos can seek; the proxy must pass
the `Range` header through. The proxy must forward plain HTTP requests on paths below
`WEBSOCKET_PATH` (the examples above do) and should not buffer the responses.

## Security checklist

- Serve `wss://` only (built-in TLS or a proxy). Plain `ws://` exposes room passwords on
  the network.
- Keep `ALLOWED_ORIGINS` to the editor addresses you use. `*` lets any web page a visitor
  opens connect to your relay with their address.
- Leave `TRUST_PROXY` off unless a proxy is in front, and then keep the relay port private
  or set `FORWARDED_SECRET` (16+ random characters). The startup warns otherwise.
- Never enable `INTERNAL_TEST_ROOMS` on a public relay.
- Keep secrets out of the config file if it is shared; pass `FORWARDED_SECRET` as an
  environment variable or a file only the relay user can read (`chmod 600`).
- Run as an unprivileged user. The Docker image already runs as `bun` with a read-only file
  system in the compose file.
- Size the limits to your machine: `OUTBOUND_BACKLOG_BYTES_TOTAL` plus a few snapshots
  (`SNAPSHOT_BYTES_MAX`) bounds memory use; lower both on small hosts.
- Restart after renewing certificates, and watch the `relay.warning` lines at start.

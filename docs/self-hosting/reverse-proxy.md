# Reverse proxy and HTTPS

The optional `proxy` profile puts the whole instance behind [Caddy](https://caddyserver.com) on **one HTTPS origin**.
The web app, the API, both WebSockets and the attachment downloads and uploads are all served from it. Caddy gets
and renews the certificates itself.

| Path on `https://<site>` | Goes to | Notes |
| --- | --- | --- |
| `/api/*`, `/ws`, `/runtime/ws`, `/docs`, `/health` | `api:4000` | REST, sign-in, browser and device WebSockets (upgraded transparently), OpenAPI |
| `/<bucket>/*` (default `/ocw-attachments/*`) | `garage:3900` | presigned attachment URLs; Host and path reach Garage unchanged |
| `/agent-channel/*` | **404** | the OpenClaw cell's API stays on the compose network |
| everything else | `web:3000` | the web app |

The configuration is `infra/caddy/Caddyfile` and `infra/caddy/compose.yaml`. The gate step
`node scripts/gate/proxy-check.mjs --up` tests it end to end. It boots a throwaway stack and enables the proxy, then
checks from outside the compose network that TLS is verified, that the WebSocket upgrades and delivers frames, and
that presigned PUT and GET work while tampered or unsigned URLs get 403. It also checks that a forged
`X-Forwarded-For` is ignored, that session cookies are `Secure`, that `/agent-channel/*` returns 404, that a 30 MiB
body on `/api/v1/runtime/files/` reaches the API uncut and that the API and web ports are on loopback only.

## A public domain (one command)

Before you start:

1. Point a DNS `A` record (and `AAAA` if the server has IPv6) for the name, e.g. `ocw.example.com`, at the server.
2. Open ports **80** and **443** (TCP, plus UDP 443 for HTTP/3) to the internet. Let's Encrypt validates on 80/443.
3. Run, in the install's directory:

```bash
pnpm ocw enable proxy --site-address ocw.example.com
```

The command does three things:

1. It writes `OCW_SITE_ADDRESS`, sets `OCW_PUBLIC_WEB_URL`, `OCW_PUBLIC_API_URL` and `OCW_S3_PUBLIC_URL` to
   `https://ocw.example.com`, sets `OCW_TRUST_PROXY=1` and `OCW_PUBLISH_ADDRESS=127.0.0.1`, and adds `proxy` to
   `COMPOSE_PROFILES`.
2. It runs `docker compose up -d --wait`, which recreates the api and web with the new URLs and starts Caddy.
3. It prints the names of the keys it wrote and the public URL. It never prints a secret.

Open `https://ocw.example.com`. The first request may take a few seconds while Caddy gets the certificate.

Options:

- `--env-file <path>` or `--dir <dir>` select the install's env file.
- `--no-up` writes the env file without starting anything. Apply it later with `docker compose up -d --wait`.

If 80/443 are taken, set `OCW_PROXY_HTTP_PORT` and `OCW_PROXY_HTTPS_PORT` in `.env` before running the command. A
non-443 HTTPS port becomes part of the public URLs, e.g. `https://ocw.example.com:8443`. Public ACME validation
still needs 80 or 443 reachable from the internet, so use this for internal names (next section) or behind your own
proxy.

## An internal name

For a name no public CA can validate (`ocw.corp.internal`, a VPN-only host), use Caddy's own certificate authority:

```bash
pnpm ocw enable proxy --site-address ocw.corp.internal --tls internal
```

This sets `OCW_PROXY_TLS=internal`. `localhost` and IP addresses use the internal CA automatically, without the flag.

Every client must then trust Caddy's root certificate. It lives in the `caddy-data` volume:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./ocw-root.crt
```

Install `ocw-root.crt` in the operating system or browser trust store of each client, or distribute it through your
device management tool. The desktop app uses the operating system's store; Node processes such as the Local Runtime
daemon also accept `NODE_EXTRA_CA_CERTS=/path/to/ocw-root.crt`. Never disable certificate verification instead.

**Connectors with a sign-in** (**Organization sign-in** or **Member sign-in**). An authorization server outside your
network cannot read OCW's client metadata document (`https://<site>/api/v1/connectors/oauth/client-metadata.json`)
behind an internal name. For each such connector, turn off **Use the client metadata URL** in Settings › MCP servers;
OCW then uses the pre-registered client or registers itself (dynamic registration). A connector whose server
publishes no OAuth protected resource metadata (RFC 9728) or no PKCE support shows **Sign-in error**: nobody can sign
in to it, so use **Client credentials**, **Organization headers** or **Member key** for it instead. **Test sign-in** in
the dialog names the failing step (see [connectors.md](connectors.md#test-sign-in-and-what-each-failure-means)).

## Cloudflare in front of the workspace

When a connector uses the client metadata URL (CIMD), the provider's server fetches
`/api/v1/connectors/oauth/client-metadata.json` from your workspace. Cloudflare bot protection (Bot Fight Mode), a
managed challenge or Cloudflare Access in front of the whole host answers that server-side fetch with a challenge, and
the provider then refuses OCW on its own sign-in page. OCW never hears back, so the failure cannot show in Settings.
Either keep that one path reachable without a challenge (a WAF skip rule or an Access bypass for
`/api/v1/connectors/oauth/client-metadata.json`), or turn off **Use the client metadata URL** for that server in
Settings › MCP servers. The callback `/api/v1/connectors/oauth/callback` is a normal navigation of the person's own
browser, so it passes Cloudflare like the rest of the workspace. Behind a Cloudflare Tunnel, also set `OCW_PUBLIC_API_URL` to the public `https://` address, or
providers send people back to `localhost` (Test sign-in reports this; see [connectors.md](connectors.md)).

## What changes when the proxy is on

- **One origin.** The browser calls `https://<site>/api/...` and opens `wss://<site>/ws` on the page's own origin.
  There is no CORS, cookies are same-site, and presigned attachment URLs point at `https://<site>/<bucket>/...`.
- **Secure cookies.** With an `https://` public API URL the session cookie is `__Secure-ocw.session_token`, flagged
  `Secure; HttpOnly; SameSite=Lax`.
- **One trusted hop.** The API takes the client IP from `X-Forwarded-For` only because `OCW_TRUST_PROXY=1`. That IP
  feeds the sign-in rate limit, the `user.sign_in_failed` audit event and the IP shown in a user's session list.
  Caddy throws away any `X-Forwarded-*` header a client sends and sets fresh ones from the connection, so a forged
  header never reaches the API through it. On a Linux server, Docker keeps the client's real address for traffic
  from outside the host. Docker Desktop (macOS, Windows) forwards published ports through its VM, so Caddy sees
  the Docker network's gateway as the address of every client. Behind it the audit shows that gateway and all
  users share one sign-in rate-limit bucket (`OCW_SIGNIN_RATE_LIMIT_PER_MINUTE`, default 30). Run production on
  Linux.
- **Loopback ports.** `OCW_PUBLISH_ADDRESS=127.0.0.1` binds the api (4000) and web (3000) ports to the host's
  loopback interface, so from the network Caddy is the only way in. Do not publish them on another interface while
  `OCW_TRUST_PROXY=1`. Anything that reaches the API directly could then send its own `X-Forwarded-For`. That
  includes processes on the server itself and containers on the compose network. If your threat model includes
  those, set `OCW_TRUST_PROXY` to your proxy's fixed address or CIDR instead of a hop count (next section).

To turn the proxy off, remove `proxy` from `COMPOSE_PROFILES`. Then set the public URLs back to the direct ports and
`OCW_TRUST_PROXY=false`, remove `OCW_PUBLISH_ADDRESS` (or set it to `0.0.0.0`), and run `docker compose up -d
--remove-orphans`.

## Bringing your own reverse proxy

nginx, Traefik, HAProxy, a cloud load balancer and others all work if they follow these rules. Leave
`COMPOSE_PROFILES` without `proxy`, and set the public URLs to your origin yourself.

1. **Keep one origin**, or at least list the web origin in `OCW_TRUSTED_ORIGINS` if the API is on another host. Set
   `OCW_PUBLIC_WEB_URL`, `OCW_PUBLIC_API_URL` and `OCW_S3_PUBLIC_URL` to the URLs browsers use.
2. **Route** `/api/`, `/ws`, `/runtime/ws`, `/docs` and `/health` to the api (port 4000), the bucket path to Garage
   (port 3900) and everything else to the web (port 3000).
3. **Upgrade WebSockets** on `/ws` and `/runtime/ws`. Forward `Upgrade` and `Connection`, and allow long-lived
   connections (idle timeouts of at least 60 s; the server pings regularly).
4. **Preserve Host and the full path on the bucket path.** Presigned URLs are signed (AWS SigV4) over the Host header
   and the path. Never rewrite `Host` for Garage. Never mount the bucket under a stripped prefix, as nginx
   `location /s3/ { proxy_pass http://garage:3900/; }` or Traefik `StripPrefix` would. In nginx use
   `proxy_set_header Host $http_host;` and `proxy_pass http://garage:3900;` with no URI part. Do not buffer or limit
   upload bodies below `OCW_ATTACHMENT_MAX_BYTES`.
5. **Do not limit or buffer request bodies on `/api/v1/runtime/files/`** below `OCW_ATTACHMENT_MAX_BYTES`. A Work Zone
   device sends the files a bot downloads from its session there (`PUT`, streamed, with a `content-length`, up to the
   organization's "Largest file a bot moves"), and fetches the files a bot uploads (`GET`). A proxy that caps the body
   answers 413 and the bot gets "transfer failed"; one that buffers the whole body holds every file in memory or on
   disk first. Caddy (the `proxy` profile) streams request bodies and sets no limit by default. nginx limits bodies
   to 1 MB unless told otherwise:

   ```nginx
   location /api/v1/runtime/files/ {
       client_max_body_size    0;      # or at least OCW_ATTACHMENT_MAX_BYTES
       proxy_request_buffering off;    # stream the body to the API as it arrives
       proxy_buffering         off;    # stream the file a device downloads
       proxy_read_timeout      600s;   # a transfer may take up to 10 minutes
       proxy_send_timeout      600s;
       proxy_pass              http://api:4000;
   }
   ```

   The API ends a transfer stream itself at the transfer's deadline (at most 10 minutes) or after 30 s without a
   byte, so a proxy timeout of at least 60 s between bytes is enough; a longer one never keeps a stalled transfer
   alive.

   **CDNs cap request bodies too** (Cloudflare's free and pro plans at 100 MB, business at 200 MB), whatever the
   proxy behind them allows. Keep the organization's limit (Settings › Work Zone policy › Bots › Largest file a bot
   moves) below your CDN's cap, or let devices reach the workspace without the CDN. The release gate checks the
   `proxy` profile with a 30 MiB `PUT` on this path (`scripts/gate/proxy-check.mjs`).
6. **Overwrite `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`**, never append to what the client sent
   (nginx: `proxy_set_header X-Forwarded-For $remote_addr;`).
7. **Block `/agent-channel/`** with a 404. It is the OpenClaw cell's API and must stay on the internal network.
8. **Set `OCW_TRUST_PROXY`** to the number of proxies in front of the API (`1` for one), or better, to their
   addresses or CIDRs as a comma-separated list (`10.0.0.5` or `10.0.0.0/29`). With a list, a forwarded header is
   only believed when it comes from one of those addresses. Keep the api port off any network your clients can
   reach.
9. **Serve HTTPS**. Plain HTTP public URLs give non-`Secure` cookies and `ws://` sockets.

To keep Caddy and put another front end on the same host in front of it (a tunnel, a load-balancer agent), add
`infra/caddy/compose.loopback.yaml` to `COMPOSE_FILE`, e.g. `COMPOSE_FILE=compose.yaml:infra/caddy/compose.loopback.yaml`.
It publishes Caddy on 127.0.0.1 only.

## Back up the `caddy-data` volume

`caddy-data` holds the certificates, the ACME account and, with `--tls internal`, the local root CA. If you lose it,
Caddy requests every certificate again. That spends your Let's Encrypt rate-limit budget (a handful of duplicate
certificates per week), and with `--tls internal` it creates a new root that every client must trust again. Back it
up with the rest of the instance, or on its own:

```bash
docker run --rm -v <project>_caddy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/caddy-data.tgz -C /data .
```

`caddy-config` only holds Caddy's autosaved runtime config and can be recreated.

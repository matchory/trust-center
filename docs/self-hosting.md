# Self-hosting the Trust Center

The whole deployment is one application container and one Postgres. Nothing
else is contacted at runtime except your OIDC issuer.

## 1. What you need

- **Docker** with Compose v2.
- **Postgres 18.** `compose.yaml` provides one; point `DATABASE_URL` at
  your own instead if you already run a managed database.
- **An OIDC issuer** that can return group memberships — Keycloak, Authentik,
  Entra ID, Okta, and Google Workspace all work. Staff roles come from groups,
  so there is no local account store and no password to manage.
- **A reverse proxy that terminates TLS.** The container speaks plain HTTP on
  port 3000 and binds to localhost in the supplied compose file.

Phase 1 needs no other external service. There is no mail server yet, because
nothing sends mail yet.

## 2. Quick start

```bash
cp .env.example .env
# Set at least: POSTGRES_PASSWORD, BASE_URL, and the OIDC_* values.
docker compose up -d
```

The application applies its own database migrations at start, so there is no
separate setup step. Open `${BASE_URL}/auth/login` and sign in.

There is **no seeded administrator and no setup wizard**: the first person in
your `OIDC_ADMIN_GROUP` who signs in becomes an admin, because that is where
the authority already lives. Anyone in neither mapped group is refused, and the
refusal is recorded in the audit log.

## 3. Every environment variable

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection string. |
| `BASE_URL` | yes | — | The public origin this deployment is reached at. Used for the OIDC redirect URI, canonical URLs, and the sitemap. Must match what visitors type, including the scheme. A trailing slash is ignored. |
| `LOCALES` | no | `de,en` | Locales this deployment serves. Must be a subset of the locales compiled into the image — the app refuses to start otherwise. See §5. |
| `DEFAULT_LOCALE` | no | `de` | The locale an unprefixed request negotiates to, and the fallback shown when content is untranslated. Must be one of `LOCALES`. |
| `STORAGE_DIR` | no | `/data/storage` | Where uploaded documents and branding assets are written. Must be a persistent volume. Nothing here is ever served directly; every read goes through the audited download endpoint. |
| `MAX_UPLOAD_MB` | no | `25` | Largest accepted upload. Keep `BODY_SIZE_LIMIT` at or above this. |
| `OIDC_ISSUER` | yes | — | Issuer URL. Discovery is fetched from `${OIDC_ISSUER}/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | yes | — | Confidential client id. |
| `OIDC_CLIENT_SECRET` | yes | — | Confidential client secret. |
| `OIDC_ADMIN_GROUP` | yes | — | Group whose members get the `admin` role. |
| `OIDC_APPROVER_GROUP` | no | — | Group whose members get the `approver` role. Leave unset if you do not separate the two. |
| `OIDC_GROUPS_CLAIM` | no | `groups` | Claim your IdP returns group memberships under. Entra ID uses `roles` for app roles. |
| `SESSION_TTL_HOURS` | no | `12` | Hours a staff session stays valid before requiring a fresh login. |
| `RUN_MIGRATIONS` | no | `true` | Whether the server applies migrations at start. Set to `false` when running more than one replica — see §7. |
| `RUN_JOBS` | no | `true` | Whether the server runs background jobs — see §7a. |
| `SMTP_URL` | for mail | — | e.g. `smtp://user:pass@host:587`. Unset means queued mail is never sent. |
| `MAIL_FROM` | for mail | `trust-center@localhost` | Envelope sender for every message. |
| `STAFF_NOTIFICATION_EMAIL` | no | — | Where "a new request is waiting for triage" notices go. Unset means none are sent. |
| `REQUESTER_SESSION_TTL_HOURS` | no | `72` | How long a verified requester stays signed in. |
| `MAGIC_LINK_TTL_MINUTES` | no | `30` | Lifetime of a single-use verification or sign-in link. |
| `ACCESS_GRANT_DEFAULT_DAYS` | no | `90` | Default expiry when staff approve without naming one. |
| `PORT` | no | `3000` | Port the server listens on. |
| `BODY_SIZE_LIMIT` | no | `32M` | Largest request body `adapter-node` accepts, uploads included. |
| `ADDRESS_HEADER` | behind a proxy | — | Header to read the client address from. Set to `X-Forwarded-For`. See §8 — without it every audit event records your proxy's address. |
| `XFF_DEPTH` | behind a proxy | `1` | How many proxies you trust in front of the app. |

`POSTGRES_PASSWORD` is read by `compose.yaml` only, to build
`DATABASE_URL` and to initialise the bundled Postgres.

## 4. Setting up the OIDC issuer

Whatever the issuer, you need: a **confidential** client, the redirect URI
`${BASE_URL}/auth/callback`, the scopes `openid email profile groups`, and a
mapper that puts group names into the token.

### Keycloak

1. **Clients → Create client.** Client type `OpenID Connect`, client ID
   `trust-center`.
2. Enable **Client authentication** (this makes it confidential) and the
   **Standard flow**. Disable direct access grants.
3. **Valid redirect URIs**: `https://trust.example.com/auth/callback`.
4. **Client scopes → trust-center-dedicated → Add mapper → By configuration →
   Group Membership.** Token Claim Name `groups`, **Full group path off** —
   otherwise the claim contains `/trust-center-admins` and will not match
   `OIDC_ADMIN_GROUP`. Tick *Add to ID token* and *Add to access token*.
5. **Credentials** tab → copy the secret into `OIDC_CLIENT_SECRET`.
6. Create the groups `trust-center-admins` and `trust-center-approvers` and add
   your staff.

`OIDC_ISSUER` is `https://keycloak.example.com/realms/<realm>`.

### Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider.** Client type
   `Confidential`, redirect URI `https://trust.example.com/auth/callback`.
2. Scopes: `openid`, `email`, `profile`, plus a **Scope mapping** named
   `groups` with the expression:

   ```python
   return {"groups": [group.name for group in request.user.ako_groups.all()]}
   ```

3. Add that scope mapping to the provider's selected scopes.
4. **Applications → Create**, bind the provider, and restrict access with a
   policy if you want more than group-based authorisation.
5. Copy the client ID and secret.

`OIDC_ISSUER` is the provider's issuer URL, typically
`https://authentik.example.com/application/o/<slug>/`.

### Other issuers

If your issuer names the claim something else, set `OIDC_GROUPS_CLAIM`. Entra
ID app roles arrive under `roles`:

```
OIDC_GROUPS_CLAIM=roles
```

## 5. Locales

Locales work in two layers, and the distinction matters when you add a
language:

- **Compiled catalogs** are a build input. The image contains a message catalog
  per locale in `messages/`, fixed when the image is built.
- **`LOCALES`** selects the subset this deployment serves, and must be a subset
  of what was compiled. A misconfiguration exits the process at start rather
  than failing every request.

So switching a running deployment from `de,en` to `de` is a setting. **Adding a
language is a rebuild**, because it needs a catalog a human has translated:

```bash
# 1. Add the catalog, translating every key present in messages/en.json.
cp messages/en.json messages/fr.json

# 2. List the locale so Paraglide compiles it.
#    project.inlang/settings.json → "locales": ["de", "en", "fr"]

# 3. Rebuild and enable it.
docker compose build app
LOCALES=de,en,fr docker compose up -d
```

Every page lives at a locale-prefixed URL (`/de/documents`), and the unprefixed
root negotiates once from `Accept-Language` and redirects.

## 6. Storage and backups

Two things hold state, and **a restore needs both**:

- **Postgres** — all content, the audit log, staff users and sessions, and the
  branding record.
- **The `storage` volume** — the uploaded files themselves. The database stores
  only an opaque key, a digest, and a size.

A database restored without its objects leaves documents that list on the
portal but fail to download. Back them up together:

```bash
docker compose exec -T postgres pg_dump -U trustcenter trustcenter \
  | gzip > trustcenter-$(date +%F).sql.gz

docker run --rm \
  -v trust-center_storage:/data:ro \
  -v "$PWD":/backup \
  busybox tar czf /backup/storage-$(date +%F).tar.gz -C /data .
```

Restoring is the same in reverse, with the application stopped.

The audit log is append-only at the database level: `DELETE`, `TRUNCATE`, and
any `UPDATE` other than clearing `ip`, `ua`, and `actor_id` are refused by
triggers. A restore that expects to prune it will fail.

## 7. Upgrading

```bash
git pull
docker compose build app
docker compose up -d
```

Migrations run at start, so this is the whole procedure for the
single-container deployment.

**More than one replica:** two replicas racing the same migration is a real
failure mode, and there is no advisory lock around it. Set
`RUN_MIGRATIONS=false` on every replica, and bring exactly one instance up with
migrations enabled first — the server applies them before it starts serving:

```bash
# Apply migrations once, then exit. Nothing starts serving.
docker compose run --rm --entrypoint node app tools/migrate.js

# Then the replicas, migrations off.
RUN_MIGRATIONS=false docker compose up -d --scale app=3
```

`tools/migrate.js` imports nothing from the application — it needs
`DATABASE_URL` and the `drizzle` folder and no other configuration — so it works
in the distroless image, which has no shell to exec into. Locally the same thing
is `pnpm db:migrate:prod`.

Take a database backup before upgrading. Migrations are not reversible.

## 7a. Background jobs

The server runs four jobs in-process on a timer. There is nothing to install and
no scheduler to configure.

| Job | Every | What it does |
|---|---|---|
| `mail:drain` | 15s | Sends queued mail from `outbound_email`, retrying with backoff. |
| `sessions:cleanup` | 1h | Deletes expired staff and requester sessions. |
| `requests:sweep` | 15m | Deletes access requests whose verification link expired unused. |

Every tick takes a Postgres advisory lock named for its job, so running more
than one replica is safe: a second instance whose tick overlaps skips that round
rather than doing the work twice. Set `RUN_JOBS=false` if you would rather run a
dedicated worker instance.

**Mail is queued, never sent inline.** A request or a staff decision is never
held up by, or failed by, an unreachable mail server. With `SMTP_URL` unset the
queue accepts work and never drains it — correct for a build or a test run, and
silent in production. If mail is not arriving, look at `outbound_email`:
`status` is `pending`, `sent`, or `failed`, and `last_error` records why the
most recent attempt failed.

## 8. Reverse proxy

The container serves plain HTTP. Terminate TLS in front of it and forward both
`X-Forwarded-For` and `X-Forwarded-Proto`.

**Set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH` to the number of proxies
you trust.** Without them every audit event records the proxy's address instead
of the visitor's, which makes the download trail worthless — and that trail is
most of why this product exists.

### Caddy

```caddy
trust.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Caddy sets both forwarded headers by default. With Caddy directly in front of
the app, `XFF_DEPTH=1`.

### nginx

```nginx
server {
	listen 443 ssl http2;
	server_name trust.example.com;

	ssl_certificate     /etc/letsencrypt/live/trust.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/trust.example.com/privkey.pem;

	# At or above MAX_UPLOAD_MB, or uploads fail at the proxy.
	client_max_body_size 32m;

	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
}
```

If a CDN sits in front of nginx, raise `XFF_DEPTH` to match.

## 9. What this deployment does not send anywhere

- **No telemetry.** Nothing reports usage, versions, or errors to us or anyone
  else.
- **No third-party requests from the portal.** No CDN, no web fonts, no
  analytics. A Content-Security-Policy with every source at `'self'` and no
  `unsafe-inline` makes the browser enforce it.
- **No cookies for public visitors.** The only cookie the product sets is the
  staff session, after a staff member signs in.

These are not promises to take on faith. `tests/e2e/security.spec.ts` asserts
each of them on every run: it records every request the portal makes and fails
on any foreign origin, checks the policy header, and checks the cookie jar is
empty. Run `pnpm test:e2e` against your own build.

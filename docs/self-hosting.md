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
| `MAX_PDF_PAGES` | no | `1000` | Largest accepted PDF, in pages. Bytes are not what a watermarked download costs — see §7b. Applies to new uploads only. |
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
| `MAIL_RETENTION_DAYS` | no | `90` | After this many days a delivered or failed notification is stripped of its address and payload. The row stays. |
| `STAFF_NOTIFICATION_EMAIL` | no | — | Where "a new request is waiting for triage" notices go. Unset means none are sent. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | Your OTLP/HTTP collector, e.g. `https://otel.internal:4318`. Unset means no telemetry is exported and no OpenTelemetry SDK is loaded. See §11. |
| `OTEL_SERVICE_NAME` | no | `trust-center` | The `service.name` attached to exported traces and metrics. |
| `OTEL_EXPORTER_OTLP_HEADERS` | no | — | Collector authentication, as `key=value` pairs separated by commas. |
| `OTEL_TRACES_SAMPLER_ARG` | no | `1` | Fraction of traces sampled, 0 to 1. The default keeps all of them. |
| `REQUESTER_SESSION_TTL_HOURS` | no | `72` | How long a verified requester stays signed in. |
| `MAGIC_LINK_TTL_MINUTES` | no | `30` | Lifetime of a single-use verification or sign-in link. |
| `ACCESS_GRANT_DEFAULT_DAYS` | no | `90` | Default expiry when staff approve without naming one. |
| `ACCESS_GRANT_REMINDER_DAYS` | no | `7` | How long before expiry the requester is reminded. The grant lapses on its own either way. |
| `NDA_ACCEPTANCE_DUE_DAYS` | no | `14` | Default days a requester has to accept an outstanding agreement before the approval lapses, when staff approve without naming one. Overridden at `/admin/settings/access`. |
| `NDA_FONT_DIR` | no | `./assets/fonts` | Directory holding the four typefaces the acceptance record and the download watermark embed — `regular.ttf`, `bold.ttf`, `italic.ttf`, `bold-italic.ttf`. See §7c. |
| `EVENT_EGRESS_ENABLED` | no | `false` | Whether configured endpoints actually deliver. Unset, nothing leaves the container however many endpoints exist. See §12. |
| `EVENT_SIGNING_KEY` | for `generic` endpoints | — | Root key, minimum 32 characters, from which each endpoint's signing secret is derived. Never stored. Required before a `generic` endpoint can be saved; `teams` endpoints do not need one. Changing it re-keys every endpoint and halts delivery until the stored canary matches. See §12. |
| `EVENT_EGRESS_ALLOW` | no | — | Comma-separated `host:port` entries permitting delivery to private address ranges, for a receiver inside your own network. Loopback and link-local are refused regardless. See §12. |
| `AUDIT_SINK_ENABLED` | no | `false` | Whether the audit log is shipped to external storage. Unset, no batch is cut and nothing leaves the container. Setting it with no sink configured refuses to boot. See §13. |
| `AUDIT_SINK_BATCH_ROWS` | no | `1000` | Maximum audit events per shipped batch. See §13. |
| `AUDIT_SINK_BATCH_MAX_AGE` | no | `15` | Minutes before a partly filled batch is shipped anyway, so a quiet deployment still ships. See §13. |
| `AUDIT_SINK_BATCH_MAX_BYTES` | no | `8388608` | Byte ceiling per batch, for deployments whose events carry large `meta`. See §13. |
| `AUDIT_SINK_ATTEST_INTERVAL` | no | `24` | Hours between attestation objects. A gap in the series is the signal that the sink was not running. See §13. |
| `AUDIT_SINK_S3_BUCKET` | with a sink | — | Bucket the batches are written to. Required together with `_REGION`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY`; setting some and not others refuses to boot. See §13. |
| `AUDIT_SINK_S3_REGION` | with a sink | — | Region for request signing. |
| `AUDIT_SINK_S3_ACCESS_KEY_ID` | with a sink | — | Access key. A write-only policy is what §13 documents and recommends. |
| `AUDIT_SINK_S3_SECRET_ACCESS_KEY` | with a sink | — | Secret key. |
| `AUDIT_SINK_S3_ENDPOINT` | no | — | For an S3-compatible store. Omit for Amazon S3. Addressed path-style. |
| `AUDIT_SINK_S3_PREFIX` | no | — | Key prefix, if one bucket holds more than one deployment. |
| `AUDIT_SINK_SYSLOG_URL` | with a sink | — | `tls://host:6514` or `tcp://host:514`, the receiver batches are streamed to. The port may be omitted. There is no UDP scheme. See §13. |
| `AUDIT_SINK_SYSLOG_CA` | no | — | PEM of the CA that signed the receiver's certificate, for the private CA an internal SIEM almost always uses. Accepts `\n` escapes. See §13. |
| `AUDIT_SINK_SYSLOG_CLIENT_CERT` | no | — | PEM client certificate, for a receiver requiring mutual TLS. Set with `_CLIENT_KEY` or neither; one alone refuses to boot. See §13. |
| `AUDIT_SINK_SYSLOG_CLIENT_KEY` | no | — | PEM private key for that client certificate. See §13. |
| `AUDIT_SINK_SYSLOG_FACILITY` | no | `local0` | Syslog facility the messages claim. One of `user`, `daemon`, `auth`, `syslog`, `authpriv`, `ftp`, `local0`–`local7`. See §13. |
| `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` | no | `8192` | Largest single framed message, matching rsyslog's default. A row above it fails the batch rather than being truncated. See §13. |
| `PORT` | no | `3000` | Port the server listens on. |
| `BODY_SIZE_LIMIT` | no | `32M` | Largest request body `adapter-node` accepts, uploads included. |
| `ADDRESS_HEADER` | behind a proxy | — | Header to read the client address from. Set to `X-Forwarded-For`. See §8 — without it every audit event records your proxy's address. |
| `XFF_DEPTH` | behind a proxy | `1` | How many proxies you trust in front of the app. |

`POSTGRES_PASSWORD` is read by `compose.yaml` only, to build
`DATABASE_URL` and to initialise the bundled Postgres.

**HTTPS is required.** Session cookies use the `__Host-` and `__Secure-`
prefixes, which browsers only accept over HTTPS. Reaching the application over
plain HTTP — other than at `localhost` — means nobody can sign in, staff or
requester, with no error message beyond a login that loops back to the login
page. Terminate TLS at your proxy and set `BASE_URL` to the `https://` origin.

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

The server runs six jobs in-process on a timer. There is nothing to install and
no scheduler to configure.

| Job | Every | What it does |
|---|---|---|
| `mail:drain` | 15s | Sends queued mail from `outbound_email`, retrying with backoff. |
| `sessions:cleanup` | 1h | Deletes expired staff and requester sessions. |
| `requests:sweep` | 15m | Deletes access requests whose verification link expired unused. |
| `grants:remind` | 6h | Mails a requester once shortly before their access expires; nudges once before an outstanding agreement's deadline; and closes approvals whose deadline has passed. |
| `retention:sweep` | 6h | Drops spent rate-limit counters, strips settled notifications of their address and payload, and deletes unconfirmed subscriptions whose confirmation token has expired. |
| `subscriptions:notify` | 15m | Mails confirmed subscribers about update posts published since they were last notified, and advances each subscription's cursor. |

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

### Update notifications

Subscribers are mailed about update posts every 15 minutes. Two consequences of
how "published" is decided are worth knowing before they surprise you.

**A back-dated post notifies nobody.** Each subscription remembers when it was
last notified, and a post is sent if it went live after that. Setting
`published_at` to a date in the past means "this was already announced", so the
post appears on the updates page and no mail goes out. That is intended — the
alternative is mailing people about a change they were told about last week.

**Re-dating a live post forward notifies again.** The mirror of the above: moving
an already-published post's date to a later time steps it back over the cursors
that had passed it, so it is sent a second time. Edit the date of a post that has
already gone out only if you mean to.

**Management links do not expire, and they appear in URLs.** Every notification
carries a link that lets its recipient change topics or unsubscribe without
signing in. It is valid indefinitely, by design — a dead unsubscribe link is a
compliance problem. It follows that if your reverse proxy logs full request
lines, those logs accumulate working management tokens. Treat them accordingly:
either do not log query strings for `/*/subscribe/*`, or hold those logs to the
same retention and access rules as the database.

## 7b. Access governance

A prospect finds a gated document on the public portal and asks for it at
`/{locale}/request`, naming the documents they want. Nothing is stored against
a person until they confirm the address: the submission holds the email inline
and a magic link goes out. Following the link renders a confirmation page and
consumes nothing — enterprise mail gateways prefetch links to scan them, and
the POST is what spends the token. Confirming creates the requester, evaluates
the access rules, and either mints a grant or leaves the request in the staff
queue at `/admin/requests`. A grant makes the documents downloadable at
`/{locale}/access`, each copy watermarked with the recipient's name, company,
and the moment it was issued. Every one of those steps writes an audit event.

**Access rules** live at `/admin/rules` and are matched against the email
domain by ascending priority; the first match decides. A pattern is either an
exact domain (`acme.example`) or a single leading wildcard
(`*.acme.example`) — deliberately not a general glob, because a pattern nobody
can reason about at decision time is worse than no rule. The action is
`auto_approve`, `review`, or `deny`. A rule also names the **tiers** it may
approve — whole tiers, ticked individually — which applies to `auto_approve`
only; a rule that names none approves no blanket, and an address matching no
rule becomes a pending request.

**What a grant covers** is three independent sets: the documents named on it,
whole tiers, and whole **access groups**. None of the three implies the others.
A tier or a group means "including documents that join later", so a document
published at a granted tier, or added to a granted group, becomes downloadable
to everyone holding that grant without anybody revisiting it. That is the point
of them, and it is the thing to weigh before granting one.

**Access groups** live at `/admin/groups`. A group is a named, reusable bundle
of documents — a saved scope — not a group of people: an approver grants
"Customer pack" by name instead of ticking eleven boxes. Each group carries a
name and description per locale. **Membership is edited on the document**, in
its editor beside the tier and category, not on the group page; the group page
shows its members read-only with a count. A group cannot be deleted while a
grant still includes it — the admin page says so and refuses — because deleting
it would silently narrow live access with nothing recording why. Revoke or
re-scope those grants first. Groups are invisible to the public portal: the
request form offers documents and per-tier blankets, never your internal
bundling.

**No new environment variables ship with access groups.** Everything about them
is content, edited in the admin surface.

**How long access lasts** comes from `ACCESS_GRANT_DEFAULT_DAYS`, overridden by
the value stored at `/admin/settings/access` — change it there and it takes
effect immediately, including for rule auto-approvals. Staff name a term in
days on any individual decision, and the expiry is derived from it. `ACCESS_GRANT_REMINDER_DAYS`
decides how long before expiry the requester is mailed; the reminder is sent
once per grant. Nothing expires the grant itself: every download path filters
on the expiry date, so access ends on its own with no job and no window in
which a lapsed grant still works. Revoking a grant at `/admin/grants` works the
same way — the next download attempt is a 404, with no restart and no cache to
invalidate.

**Why there is a page limit as well as a size limit.** Watermarking loads the
whole document, stamps every page, and re-saves it, so what a gated download
costs tracks page count rather than file size. Measured at the 25 MB
`MAX_UPLOAD_MB` ceiling: 16,200 pages take 9.1 seconds and 1.4 GB of resident
memory to serve once, while 100 pages of the same 25 MB take 0.4 seconds and
77 MB. `MAX_PDF_PAGES` is what bounds that. It is enforced when a file is
uploaded, so a document already in storage from before you lowered it keeps
working — re-upload it if you need the new limit applied.

**To erase a requester,** see [§10](#10-erasure-requests).

## 7c. Agreements and the NDA tier

A document at the **`nda` tier** is one nobody sees until they have accepted an
agreement. The tier alone is not the whole rule: an access group can carry an
agreement too, and then every document in that group requires it whatever tier
it sits at.

### Writing one

Agreements live at `/admin/agreements`. A **template** is the agreement as a
thing — "Mutual NDA" — with a name and description per locale. What people
actually sign is a **version** of it, and a version has a body per locale.

The body is Markdown, restricted to headings, paragraphs, bold, italic, ordered
and unordered lists, and horizontal rules. No tables, images, or raw HTML. The
restriction is checked when you save, not when somebody reads: an agreement that
cannot be rendered must never become one a person is asked to sign. The preview
on the version page is the same renderer the requester sees and the same one the
record PDF is laid out from — there is no second implementation for the two to
drift apart in.

**Publishing is all-or-nothing across your locales.** A version with a body in
German but not English cannot be published while both are enabled. Half a
contract is not a contract, and the alternative — showing somebody the other
language — is worse than showing them nothing. The version page names which
locale is blocking.

The **effective version** is the newest published, non-retired one that is
complete in every enabled locale. That is what a requester is shown and what an
approver may require. Enabling a new locale can therefore un-publish an
agreement in practice: the version stays published but stops being effective
until it has a body in the new language. The agreement page says so.

**A version becomes immutable the moment somebody accepts it.** After that you
cannot edit its body — you publish a new version instead, and the new version is
a *new agreement* for the purposes of coverage: someone who accepted version 2
does not thereby hold version 3. Everyone who needs the new one will be asked to
accept it. Weigh that before publishing over a wording tweak.

**Templates retire rather than delete.** Retiring one stops it being proposed or
required; it does not touch the records of people who already signed it, and it
cannot, because those records are the evidence the agreement exists for.

### Requiring one

When a request reaches `/admin/requests`, the decision page lists the agreements
the requested scope currently requires — the union of the agreements carried by
the groups those documents are in, plus the default agreement for anything at
the `nda` tier. **The default is set at `/admin/settings/access`**, and an
`nda`-tier document with no default configured cannot be approved at all: the
page says so rather than quietly granting an ungated document.

For each agreement the approver either **confirms** it or **waives** it with a
reason. A waiver is recorded as a row, not as an omission — "we have this on
paper, signed last year" is a decision somebody made, and the record of it is
what stops the requirement being silently re-imposed later.

**The clock starts at acceptance, not at approval.** An approval with an
outstanding agreement mints a grant that confers nothing yet: it has no expiry,
and the requester has `NDA_ACCEPTANCE_DUE_DAYS` (or the value at
`/admin/settings/access`) to accept before the approval lapses. They get one
reminder before that deadline. When they accept, the term you chose starts
running from that moment — a prospect who took a week to read the agreement does
not lose a week of access. The grants page shows such a grant as *pending
acceptance* with no end date, and as *unaccepted* once the deadline passes.

**Requirements are frozen at approval, and re-checked at delivery.** What the
approver confirmed is what the grant waits on. But a document can gain an
agreement afterwards — you add it to a group that carries one, or move it to the
`nda` tier — and from that moment it stops being downloadable to anyone who has
not accepted, without you revisiting a single existing grant. This only ever
takes documents away, never adds them.

### What a person signs, and what is kept

The requester reads the agreement at `/{locale}/access/agreements`, types their
name, and accepts. That produces an **acceptance record**: a PDF carrying the
exact text they were shown, their typed name, email, company, the timestamp in
UTC, the IP address, and the SHA-256 of the text. It is stored, mailed to them,
mailed to `STAFF_NOTIFICATION_EMAIL` if you have set one, and downloadable from
their access page afterwards.

The hash is what makes it evidence: the record pins the exact bytes that person
saw, and a version already accepted can no longer be edited, so the two agree
permanently.

**An erasure request does not erase the acceptance.** The name, address, company
and hash on it stay — either the record identifies the counterparty or it should
not be retained at all, and a record saying somebody once typed a name is the
same as not keeping one. The *rendered PDF* is deleted, because it says the same
things in richer form and the columns already hold what the exemption needs.
Everything else about that person is erased as usual. See
[§10](#10-erasure-requests).

### Per person or per company

`/admin/settings/access` offers an **acceptance scope**: `person` or `domain`.

`person` is the default and means what it says — each individual signs.

`domain` means one signature covers everyone at that company's email domain.
This is what DACH practice usually expects and what Conveyor defaults to, and it
is a real widening: a colleague of the person who signed gets access without
signing anything, and without a record naming them. It is bounded to domains an
`auto_approve` rule matches, so a free-mail address that reached you through a
hand-approval cannot spread coverage to everybody else on that provider. Turn it
on deliberately, not by default.

### Typefaces

The acceptance record and the download watermark embed four faces of Source Sans
3 (SIL OFL 1.1, bundled), covering Latin, Latin Extended, Greek and Cyrillic in
about 1.2 MB. A standard PDF font would mangle `Łukasz` or `Şule` into question
marks, and on a contract the mangled string is the typed name standing in for a
signature.

If your signatories write in a script that is not covered — CJK, for instance —
put four TTFs named `regular.ttf`, `bold.ttf`, `italic.ttf` and `bold-italic.ttf`
into a directory and point `NDA_FONT_DIR` at it. Four faces, not one: the
Markdown subset admits bold and italic, and therefore both at once, and a
bold-italic run with no face to draw it is a silent substitution inside a
contract. A name outside the loaded font's coverage currently fails the download
rather than degrading, so supply the faces before you need them.

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

- **No telemetry by default.** Nothing reports usage, versions, or errors to us
  or to anyone else, and with `OTEL_EXPORTER_OTLP_ENDPOINT` unset the
  application loads no OpenTelemetry SDK at all. If you set it, traces and
  metrics go to **your** collector and nowhere else — never to us — and they
  carry no personal data by design (§11).
- **No third-party requests from the portal.** No CDN, no web fonts, no
  analytics. A Content-Security-Policy with every source at `'self'` and no
  `unsafe-inline` makes the browser enforce it.
- **No cookies for public visitors.** The product sets exactly two cookies,
  both after someone signs in and neither on a public page: the staff session,
  which the `__Host-` prefix requires be scoped to the whole site, and the
  requester session, scoped to `/{locale}/access`. A visitor who never signs in
  is never given one.

- **No outbound events unless you configure them.** `EVENT_EGRESS_ENABLED` is
  unset by default, and with it unset nothing is delivered to anywhere, no
  matter what endpoints exist in the database. If you turn it on and add an
  endpoint, this deployment POSTs events to **your** URL and nowhere else —
  never to us (§12). The three bullets above are unchanged by that: egress is
  server-to-server, so the portal still makes no third-party request from a
  visitor's browser, still loads no foreign origin, and still sets no cookie
  for a public visitor.

These are not promises to take on faith. `tests/e2e/security.spec.ts` asserts
each of them on every run: it records every request the portal makes and fails
on any foreign origin, checks the policy header, and checks the cookie jar is
empty. Run `pnpm test:e2e` against your own build. That spec covers the
browser-side claims, which is the whole of what it ever claimed to cover —
enabling egress does not weaken it, because what egress sends leaves the
container, not the page.

## 10. Erasure requests

A requester — someone who asked for a gated document and confirmed their email
address — can be erased from `/admin/requesters/{id}`. Purging is immediate and
**cannot be undone**; nothing in this database keeps a copy of what it cleared.

**If you have enabled the audit log sink (`AUDIT_SINK_ENABLED`), read this
before you tell anyone their data is gone.** Audit events shipped to the sink
before the purge are already in your object storage, carrying the IP address,
user agent and actor id this clears. The purge does reach the sink: each
pseudonymized row ships again with those columns nulled, so the sink ends up
holding both the original and the corrected copy. Removing the original is a
deletion in your bucket, and whether you can perform it depends on the lock mode
you chose — under the recommended governance mode you can, under compliance mode
nobody can until the retention period expires. See
[§13](#13-audit-log-sink).

**What it removes**

- The person's name, company, company domain, notes, and email address on their
  `requester` row. The email is replaced with a unique unusable placeholder
  rather than emptied, because the column is unique and NOT NULL.
- Their name, IP address, and user agent from every notification queued or sent
  to them, and the payload of every one of those notifications. A notification
  still waiting to go out is stopped.
- Their actor id, IP address, and user agent from every audit event they caused.
- Every active session they hold.

**What it deliberately keeps**

- **The audit events themselves.** They are pseudonymized, not deleted: the
  record that a document was downloaded at a particular moment survives, without
  the record of who downloaded it. This is the only operation anywhere in this
  product that modifies `audit_event`, and it is column-scoped to those three
  identifiers — a database trigger refuses every DELETE regardless.
- **The `requester` row itself**, blanked. Their grants and requests reference
  it, and dropping the row would take that history with it.
- **Their grants and requests**, which continue to show what was asked for and
  what was decided.
- **The identifying columns on any agreement they accepted** — the typed name,
  address, company, domain, and the hash of the text. This is the one exception
  to everything above, and it is confined to `nda_acceptance`: either the record
  identifies the counterparty or it should not be retained at all, and a record
  saying somebody once typed a name is the same as not keeping one. The rendered
  PDF of that record *is* deleted, since it says the same things in richer form.
  Keeping the company domain is also what lets a colleague stay covered under
  `domain` acceptance scope when the one person who signed is erased. See
  [§7c](#7c-agreements-and-the-nda-tier).

**What it does not do**

It does not revoke their grants. A purged requester holds no session and cannot
sign in, so the grants are unreachable, but revoke them explicitly from
`/admin/grants` if your retention policy calls for it.

The purge writes its own audit event, `requester.purged`, naming the staff
member who performed it and how many events were pseudonymized. That event is
about the operator, not the erased person, and it survives.

## 11. Telemetry

Off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`. With it set, the application
exports traces and metrics to your own OTLP/HTTP collector — never to us, and
never anywhere you have not configured.

**What it sends.** One span per HTTP request, named for the matched route; one
per background job tick and per mail send; two per document download — the
mediated read out of storage, with the watermarking nested inside it, so a slow
download tells you whether the time went to storage or to stamping; and one
around the migration step at boot, so a deploy that is slow to come up tells you
whether the migration is the reason. Four
metrics: request duration, job tick duration and outcome, and the depth of the
outbound mail queue. Every audit event written during a request carries that
request's trace id in `request_id`, so an access in the audit log and the trace
that produced it are the same identifier.

**What it never sends.** No email address, requester name, company, IP address,
user agent, session or magic-link token, URL query string, or SQL parameter.
This is a hard boundary, not a setting: telemetry leaves the reach of the
erasure path in §10, so it carries nothing that erasure would need to reach.
`tests/unit/telemetry-request.test.ts` asserts it on every run.

**The mail queue gauge is the one to alert on.** Nothing in this deployment
sends mail inline — everything is queued and drained by the job runner — so a
broken SMTP configuration looks perfectly healthy from the outside while the
queue grows. `trustcenter.mail.queue.depth` rising without falling is the
signal. Note that a deployment with no `SMTP_URL` is a supported configuration
in which that number grows forever by design.

**Where export failures show up.** A malformed endpoint refuses to boot, but a
well-formed one pointing somewhere unhelpful cannot be caught before the first
export is attempted. Those failures — a 404 from a collector that does not
serve `/v1/traces`, a 401 from a stale token in `OTEL_EXPORTER_OTLP_HEADERS`, a
refused connection — are written to the container log as structured JSON with
`"scope":"telemetry"`, the same shape a failing background job uses:

```sh
docker compose logs trust-center | grep '"scope":"telemetry"'
```

Nothing is logged when telemetry is off. A trailing slash on the endpoint is
tolerated: it is stripped at startup, so `https://otel.example:4318/` and
`https://otel.example:4318` behave identically.

Only the four `OTEL_*` variables in §3 are read. Other standard OpenTelemetry
environment variables are deliberately ignored, because every setting in this
application is validated once at startup and a typo must refuse to boot rather
than silently export nothing.

## 12. Event egress (integrations)

Off unless you turn it on. With `EVENT_EGRESS_ENABLED` unset, no endpoint you
configure delivers anything and no request leaves the container — the switch
lives in the environment precisely so that "does this deployment call out?" is
answerable with `docker inspect`, without a database.

An **endpoint** is a URL this deployment POSTs a JSON event to when something
happens: an access request comes in, a grant is revoked, an NDA is accepted, a
document is downloaded. It exists so a trust center fits into what you already
run — an n8n workflow, a Teams channel, a CRM — rather than becoming another
inbox somebody has to remember to check.

Endpoints are rows, not configuration. You add and edit them under
**Settings → Integrations**, which is admin-only: an endpoint URL is where a
prospect's name and address get sent, so it is a more consequential thing to
edit than a FAQ entry.

### The three variables

They are in §3 with the rest; repeated here because this is the section you
are reading when you set them.

| Variable | Default | What it does |
| --- | --- | --- |
| `EVENT_EGRESS_ENABLED` | `false` | The switch. Off, endpoints can be configured but nothing is delivered. |
| `EVENT_SIGNING_KEY` | — | Root key, at least 32 characters. Required before a `generic` endpoint can be saved; `teams` endpoints do not need one. |
| `EVENT_EGRESS_ALLOW` | — | Comma-separated `host:port` entries permitting delivery to private address ranges. Only needed for a receiver inside your own network. |

Generate a key with `openssl rand -hex 32`. It is never stored: each endpoint's
secret is derived from it, so a stolen database backup yields every endpoint
row and still no ability to forge a signature. The flip side is that changing
`EVENT_SIGNING_KEY` re-keys every endpoint at once — the application stores a
canary on first use and halts delivery, loudly, if the key it boots with does
not match the one the canary was written with. That is deliberate: restoring a
backup into an environment with a different key would otherwise silently
invalidate every signature you have configured downstream.

### The two payload shapes

**`generic`** — the model rendered directly, for n8n, a webhook receiver, or
anything that reads JSON. Envelope keys are `snake_case`; keys inside `data`
are `camelCase`, because `data` is domain state and the envelope is wire
format. A real `access_request.pending` body:

```json
{
  "event": "access_request.pending",
  "at": "2026-09-03T09:14:22.108Z",
  "event_id": "3f2b0c7e-8a41-4d55-9e0a-1c2d3e4f5a6b",
  "seq": "48213",
  "delivery_id": "b91d4c02-77e5-4a19-8f3c-2d6e0a1b4c8d",
  "verified": true,
  "subject": { "type": "access_request", "id": "9c1e5a3d-…" },
  "actor": { "type": "requester", "id": "5d7f2b91-…" },
  "summary": "Access request pending for Acme GmbH",
  "link": "https://trust.example.com/de/admin/requests/9c1e5a3d-…",
  "data": {
    "name": "Alex Fischer",
    "email": "alex.fischer@acme.example",
    "company": "Acme GmbH",
    "companyDomain": "acme.example",
    "requestId": "9c1e5a3d-…",
    "status": "pending",
    "justification": "Vendor security review",
    "termDays": 90
  }
}
```

`seq` is a **string**, not a number. It is a 64-bit integer and a consumer
parsing it as a JSON number loses precision above 2^53 — which matters,
because `seq` is what lets you detect that you missed something.

**`teams`** — an Adaptive Card in the envelope the Teams **Workflows** (Power
Automate) trigger expects. Office 365 Connectors are retired, so this is not a
`MessageCard`. Card version 1.4, no images and no external references: nothing
in your Teams channel fetches anything from us.

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": [
          { "type": "TextBlock", "text": "Access request pending for Acme GmbH", "wrap": true, "weight": "Bolder" },
          { "type": "TextBlock", "text": "access\\_request.pending", "wrap": true, "isSubtle": true, "spacing": "None" },
          { "type": "FactSet", "facts": [{ "title": "company", "value": "Acme GmbH" }] }
        ],
        "actions": [
          { "type": "Action.OpenUrl", "title": "Open in trust center", "url": "https://trust.example.com/de/admin/requests/9c1e5a3d-…" }
        ]
      }
    }
  ]
}
```

Card text is markdown-escaped (note `access\_request.pending`) because a
company name is free text somebody else typed. The action URL is not escaped —
it is our own absolute link, and an escaped URL is a broken button.

### Verifying the signature

Every `generic` delivery carries three headers:

| Header | |
| --- | --- |
| `x-trust-center-event` | The action name, so you can route without parsing the body. |
| `x-trust-center-delivery` | The delivery id. **This is your idempotency key** — see below. |
| `x-trust-center-signature` | `t=<unix-seconds>,v1=<hex>` and, during a rotation, a second `v1=`. |

The signed input is `` `${t}.${body}` `` — the timestamp, a literal dot, then
the **raw** request body, before any JSON parsing or re-serialisation.

Reveal the endpoint's secret under Settings → Integrations. It is shown as hex
and you **must decode it to bytes** before using it as the HMAC key; using the
hex string itself as the key is the one mistake that produces a signature
mismatch with everything else correct.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secretHex, toleranceSeconds = 300) {
	const parts = header.split(',').map((part) => part.split('='));
	const t = parts.find(([key]) => key === 't')?.[1];
	if (!t) return false;

	// Reject a replayed body. Our own retries span at most fifteen minutes but
	// never reuse a timestamp, so a tight tolerance costs you nothing.
	if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;

	const key = Buffer.from(secretHex, 'hex'); // NOT the hex string itself
	const expected = createHmac('sha256', key).update(`${t}.${rawBody}`).digest();

	// Accept ANY v1: during a rotation both the new secret and the previous one
	// are sent, and rejecting the second breaks the overlap that makes rotation
	// possible without downtime.
	return parts
		.filter(([key_]) => key_ === 'v1')
		.some(([, hex]) => {
			const candidate = Buffer.from(hex, 'hex');
			return candidate.length === expected.length && timingSafeEqual(candidate, expected);
		});
}
```

Rotating an endpoint's secret ("Rotate" on its page) bumps its version and
sends both signatures for a grace period, so you can update your consumer
without dropping deliveries. Rotating `EVENT_SIGNING_KEY` itself does not: it
re-keys every endpoint at once, and the canary halts delivery until it matches.

### Deduplicate on the delivery id, never on the body

**A retry is not byte-identical to the attempt before it.** Deliveries render
from live state at the moment they are attempted, so an event retried after an
access request was approved carries the *approved* state, and each attempt is
signed with a fresh timestamp. Hashing the body to detect a duplicate will
therefore fail to detect one.

`x-trust-center-delivery` is stable across every attempt of the same delivery.
That is the key to store.

### Ordering, gaps, and what `seq` is for

Delivery order is roughly commit order, **not** `seq` order, and a consumer
must not assume `seq` arrives monotonically. Events are picked up once the
transaction that wrote them is guaranteed committed, and a slow transaction
commits after a fast one that started later. `seq` still makes a *gap*
detectable; it does not order the stream.

Permanent gaps in `seq` are normal and are not lost events: a rolled-back
transaction consumes a sequence value, and so does Postgres' sequence caching.

### High-frequency actions

**`document.downloaded`** is the noisy one: one grant holder working through
forty documents produces forty notifications. It is not throttled, and the
admin UI warns you when a pattern you have selected exceeds roughly 200 events
a week — counted across every action the pattern matches, so `document.*` warns
on the total you are actually signing up for.

Which events belong in your channel is your decision, not this application's;
you are told what you are choosing rather than quietly given less than you
asked for.

**Filters can name any action**, including ones the audit log writes but this
subsystem has no enricher for. Those still deliver, carrying the audit event's
own `meta` as `data` and `"verified": false` — the flag is on the wire so you
can branch on it without knowing which of our action names implies a verified
identity. `access_request.submitted` is deliberately in this group: its data is
free text from a public form, so it is delivered unenriched rather than given
the appearance of verified fact.

### What a purge does to a delivery

When you erase a requester (§10), any queued delivery about them is marked
`skipped` and **nothing is sent** — not a payload with the name blanked out.
Blanks are the one shape a consumer cannot branch on: "a person with no name"
and "a person who was erased" would be indistinguishable, and a CRM upserting
on email would happily write the blank over the real record.

`skipped` is a status rather than a deleted row, so the gap stays visible
afterwards.

### The test send, and what its failures mean

Each endpoint's page has **Send test event**, which delivers a synthetic
`egress.test` event immediately. It bypasses exactly three things — the cursor,
the filter and the queue — and nothing else: the destination checks, the port
and scheme restrictions, the redirect refusal and `EVENT_EGRESS_ENABLED` all
apply, because an admin-triggered request that skipped them would be a
hand-built SSRF probe with a UI. `egress.test` is deliberately not an audit
action, so no filter can match it and it never appears in the audit log.

The failure it reports is one of a fixed set:

| Reason | What it means |
| --- | --- |
| `url` | The URL was refused before any connection was attempted: a scheme other than `http`/`https`, credentials embedded in the URL, an IPv6 literal, a host that is not a canonical name or dotted-quad IPv4, or a port other than 80 or 443 that you have not named in `EVENT_EGRESS_ALLOW`. |
| `destination_denied` | The name resolved to an address delivery is not allowed to reach — loopback, link-local (including the cloud metadata endpoint), or a private range you have not listed in `EVENT_EGRESS_ALLOW`. |
| `redirect_refused` | The receiver answered with a redirect. Redirects are never followed; point the endpoint at the final URL. |
| `timeout` | No response within ten seconds. |
| `network` | The connection failed outright — DNS, TLS, or a refused socket. |
| `http_status` | The receiver answered with a status that is not a success. The code is shown next to it. |
| `signing_key_missing` | A `generic` endpoint with no `EVENT_SIGNING_KEY` configured. |
| `egress_disabled` | `EVENT_EGRESS_ENABLED` is off. The test send is refused like any other delivery — the switch means nothing leaves the container, and an admin-triggered send is not an exception to it. |

A response body is never stored, only the status code and one of these fixed
phrases. A receiver that echoes its input — n8n's "respond with incoming items"
is the common one — would otherwise write a prospect's name back into this
database in a column the erasure path does not know about.

### When an endpoint goes quiet

An endpoint that has not succeeded in 24 hours is disabled automatically, and
the reason is recorded and shown on its page. Re-enabling offers two choices,
and it offers **"enable, skipping the backlog" first**: a channel flooded with
a day of stale notices is worse than a gap, and the audit log remains the
record of record either way — nothing is lost, only un-notified.

### The boundary this stops at

An event that leaves this application has left the reach of its erasure
mechanism. `purgeRequester` clears personal data from this database and from
mail queued but not yet sent; it cannot reach an n8n execution history, a Teams
channel, or a CRM record that an earlier delivery caused to be written. Those
are your systems, on your subprocessor list, and your Art. 17 obligation
reaches them exactly as it reaches the HubSpot record your automation wrote.

## 13. Audit log sink

Off unless you turn it on. With `AUDIT_SINK_ENABLED` unset, no batch is cut and
nothing leaves the container — the same shape as §12's switch, and answerable
the same way, with `docker inspect` rather than a database query.

The audit log records what happened in this deployment: who approved a request,
when a document was downloaded, when a grant was revoked. It lives in a table
that refuses DELETE and TRUNCATE at the database level. The sink copies it, in
batches, into storage you control and this application cannot delete.

**What it lets you claim, and what it does not.** With the sink running against
a locked bucket you can show an auditor a record this application had no ability
to alter after the fact, with a digest per batch they can re-verify themselves.
You cannot claim the log is complete: a batch reaches the bucket only if the job
ran, so the honest statement is "everything the sink shipped is intact and
unaltered", not "everything that happened is here". The attestation series below
is what turns the second question into an answerable one.

### The variables

They are in §3 with the rest; repeated here because this is the section you are
reading when you set them.

| Variable | Default | What it does |
| --- | --- | --- |
| `AUDIT_SINK_ENABLED` | `false` | The switch. Off, no batch is cut and nothing ships. |
| `AUDIT_SINK_BATCH_ROWS` | `1000` | Maximum audit events per batch. |
| `AUDIT_SINK_BATCH_MAX_AGE` | `15` | Minutes. Ships a partly filled batch rather than waiting for `BATCH_ROWS` on a quiet deployment. |
| `AUDIT_SINK_BATCH_MAX_BYTES` | `8388608` | 8 MiB. A second ceiling, for deployments whose events carry large `meta`. |
| `AUDIT_SINK_ATTEST_INTERVAL` | `24` | Hours between attestation objects. |
| `AUDIT_SINK_S3_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | — | All four together, or none. |
| `AUDIT_SINK_S3_ENDPOINT` | — | For an S3-compatible store. Omit for Amazon S3. |
| `AUDIT_SINK_S3_PREFIX` | — | A key prefix, if one bucket holds more than one deployment. |
| `AUDIT_SINK_SYSLOG_URL` | — | `tls://host:6514` or `tcp://host:514`. Configures the syslog sink on its own. |
| `AUDIT_SINK_SYSLOG_CA` | — | PEM of the CA that signed the receiver's certificate. |
| `AUDIT_SINK_SYSLOG_CLIENT_CERT`, `_CLIENT_KEY` | — | PEM client certificate and key, for mutual TLS. Both together, or neither. |
| `AUDIT_SINK_SYSLOG_FACILITY` | `local0` | The facility the messages claim. |
| `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` | `8192` | Largest single framed message. A row above it fails the batch. |

`AUDIT_SINK_ENABLED=true` with no sink configured is a **boot failure**, not a
silently disabled sink. So is setting some of the four required S3 variables and
not the others, and so is setting one half of the mutual-TLS pair. A deployment
that accepted any of these would accumulate batches nothing ships while you
believed something was running.

Either sink alone is a configured sink, and both together are two: each batch is
shipped to each of them, with its own shipment record, its own backoff and its
own row in the panel.

### Setting up the bucket

Object lock can only be enabled when a bucket is **created**, and it requires
versioning. There is no way to add it to an existing bucket, so this is the one
decision to get right first.

```bash
aws s3api create-bucket --bucket audit-log --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1 \
  --object-lock-enabled-for-bucket

aws s3api put-object-lock-configuration --bucket audit-log \
  --object-lock-configuration '{
    "ObjectLockEnabled": "Enabled",
    "Rule": { "DefaultRetention": { "Mode": "GOVERNANCE", "Days": 365 } }
  }'
```

The default retention on the bucket is what protects each object: this
application sends **no** per-object retention headers, deliberately, so that
retention stays your decision and the credentials it holds need no permission to
set one.

**Governance mode is the recommended default.** It refuses every delete —
including one made with the root credentials of the account — unless the caller
holds `s3:BypassGovernanceRetention` and asks for the bypass explicitly. That is
a real lock: the credentials this container holds cannot delete anything, which
is the property the audit record needs. It is also dischargeable by you, which
matters for the erasure case below.

**Compliance mode** makes deletion impossible for anybody, including you,
including AWS support, until the retention period expires. Choose it only if you
have decided the immutability is worth the consequence in the next paragraph,
because you cannot undo the choice for objects already written.

### Erasure, and the boundary this creates

§10 says a purge cannot be undone and this database keeps no copy. With a sink
enabled, that is a statement about this database and not about your bucket.

Audit events shipped **before** a purge are in the bucket carrying the IP
address, user agent and actor id the purge cleared. The purge does reach the
sink, structurally: each pseudonymized row is picked up again and re-shipped
with those columns nulled, so the bucket ends up holding both the original and
the corrected copy. Removing the original is a deletion in your bucket:

- **Under governance mode** you can perform it, with a principal holding
  `s3:BypassGovernanceRetention`. You will need the object's version id — a
  retried batch writes a second version under the same key.
- **Under compliance mode** nobody can, until the retention period expires. If
  you chose compliance mode, you have chosen that an erasure request cannot be
  fully honoured in this one place for that period. Say so in your privacy
  notice rather than discovering it during a DSAR.

### Choosing a retention period

Pick the shortest period that satisfies the obligation you are keeping this
record for, and write that period into your privacy notice and your records of
processing. A ten-year or unbounded lock on data that includes IP addresses is
the version that is hardest to defend under the storage-limitation principle,
and nothing else in this design steers you away from it.

**365 days is the recommended starting point**: it covers a full SOC 2
observation window and a year of ISO 27001 surveillance, which is what most
people are keeping this for. Extend it deliberately, with a reason you could
state to a supervisory authority. This paragraph is not legal advice and does
not substitute for your counsel; it exists so the default is not "forever" by
inattention.

### The credentials this deployment needs

A write-only policy, so the sovereignty claim is checkable rather than a
promise. This one was applied to a MinIO bucket on 2026-09-04 and exercised: a
PUT succeeded, a DELETE was refused with `Insufficient permissions`, and a
listing was refused.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ShipAuditBatches",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::audit-log/*"
    },
    {
      "Sid": "ReadLockStatusForTheAdminPanel",
      "Effect": "Allow",
      "Action": ["s3:GetBucketObjectLockConfiguration"],
      "Resource": "arn:aws:s3:::audit-log"
    }
  ]
}
```

No `s3:DeleteObject`, no `s3:BypassGovernanceRetention`, no `s3:ListBucket`. The
second statement is optional and grants nothing but the ability to read the
bucket's lock configuration; without it the admin panel reports the lock status
as **unknown**, because it genuinely cannot see one. Grant it — a panel that
says "unknown" is doing its job, but it cannot confirm the thing you set the
bucket up for.

### S3-compatible stores

Verified here against **MinIO** (`quay.io/minio/minio`, 2026-09-04): bucket
creation with lock, a governance default, a re-PUT to an existing key adding a
version rather than being refused, and a delete refused without the bypass and
permitted with it. The integration test suite runs against it on every CI run.

For **Amazon S3** the behaviour above is what the Object Lock documentation
specifies, and it has not been exercised against a real Amazon bucket by this
project — see the design's §16.

For any other S3-compatible store, do not take object-lock support on the
vendor's feature list. Configure it, grant the optional statement above, and
read the lock row in **Settings → Integrations**: it reports `governance`,
`compliance`, `none` or `unknown` from what the store actually answers. A store
that reports `none` accepts the writes and protects nothing.

### What arrives in the bucket

Two objects per batch, plus a periodic attestation:

```
audit/2026/09/04/{batch-id}.ndjson           one JSON object per audit event
audit/2026/09/04/{batch-id}.manifest.json    row count, cursor, digest
attest/2026/09/04/{timestamp}.json           the periodic attestation
```

Keys are prefixed with `AUDIT_SINK_S3_PREFIX` when you set one.

**Verifying a batch** is one command:

```bash
sha256sum batch.ndjson   # must equal .digest in the manifest
```

The manifest is the authority for what that object contains. It carries the row
count and the digest of the bytes actually written, so a batch rebuilt after an
erasure describes itself honestly rather than claiming the contents it would
have had.

### The attestation, and why coverage is a comparison

Every `AUDIT_SINK_ATTEST_INTERVAL` hours the sink writes an attestation object:
the total number of audit events, the highest sequence number, the reader's
cursor, and how many batches have been shipped since the last one.

It exists because the sink writes no audit events of its own — recording a
shipment would create an event that needs shipping, which would create an event.
So the log cannot testify that the sink was running. Without a regular series,
switching the sink off, removing rows and switching it back on would leave no
trace anywhere. **A gap in the attestation series is the signal.** An auditor
should ask what happened during it.

To check coverage, compare the newest attestation's `event_count` and `max_seq`
against the batches you hold. The admin panel shows the same comparison for the
live database.

### At-least-once, and how to deduplicate

An event may be shipped more than once — a crash between a successful
delivery and the row that records it, a restore, a re-ship after an erasure,
and for the syslog sink also a receiver that reset the connection after
taking the batch — that sink's steady-state failure, not a rare one (see
*What shipping to a SIEM cannot promise*, below). When you load what was
shipped, from either sink:

- **Deduplicate on `id`**, and order by the **manifest's cursor**, not by
  `seq`. `id` is a field of every row wherever you load it from — an NDJSON
  line in the bucket, or the JSON body of an `audit` message at a SIEM, where
  messages belonging to one batch also share that batch's id in PROCID.
  Sequence numbers are assigned when a transaction starts, so they do not
  arrive in order and a later event can carry a lower `seq` than one already
  shipped. Object keys are dated, not ordered, and PROCID is not either.
- **Nulls alone do not indicate an erasure.** Most audit events have no IP
  address to begin with — anything a background job or the system itself did.
  Only a *differing pair* under one `id` shows that a purge happened.
- **A duplicate is not evidence of an erasure.** It has several other causes,
  listed above.

Detect gaps over the union of all batches you hold, not within one: batches are
not contiguous in `seq`, and a manifest's `min_seq`/`max_seq` are
informational.

### After restoring a database backup

`pg_restore`, a `\copy` migration and a logical-replication upgrade all rewrite
the internal transaction ids the reader's cursor is built on. The reader detects
this and **stops, loudly, rather than guessing** — it will not silently re-ship
your entire history into storage nothing can delete, and it will not silently
skip everything either.

Re-seed the cursor after such a restore: insert a zero-row batch whose cursor is
the restored cluster's current position. Until you do, the sink ships nothing
and the admin panel's oldest-pending age grows, which is the intended behaviour
— a loud stop is the point.

### When a shipment fails

There is no attempt ceiling and no auto-disable. A sink that cannot be reached
is retried, with a backoff from one minute up to one hour, forever. The audit
record is not something to give up on delivering, and unlike an event endpoint
there is no channel being flooded.

The reason is recorded from a fixed set, never the provider's message — a store
that echoes its input would otherwise write a prospect's details into a table no
purge reaches. Look it up here:

| Reason | What it means |
| --- | --- |
| `config` | The batch's own metadata could not be read. Not a network problem. |
| `tls` | The TLS handshake failed. |
| `timeout` | No response within thirty seconds. |
| `network` | The connection failed outright — DNS, TLS, or a refused socket. For syslog, also a receiver that reset the connection after taking the batch — see *What shipping to a SIEM cannot promise* below. |
| `auth` | The credentials were rejected. Check the access key and secret. |
| `permission` | The credentials are valid but not allowed to write. Check the policy above. |
| `not_found` | The bucket does not exist, or the endpoint points somewhere else. |
| `http_status` | The store answered with something else. The code is shown next to it. |

The last four — `auth`, `permission`, `not_found` and `http_status` — are read
off an HTTP status code, so only the S3 sink can report them. A syslog shipment
reports one of `config`, `tls`, `timeout` or `network`, and `config` there means
a row exceeded `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES`.

### The syslog transport

Set `AUDIT_SINK_SYSLOG_URL` and every batch is also streamed to a syslog
receiver — a SIEM, an rsyslog relay, whatever collects logs where you are — as
RFC 5424 messages framed per RFC 6587. This is the sink to reach for when the
audit log needs to land where your alerting already lives. It does not replace
the bucket, and the subsection **What shipping to a SIEM cannot promise** below
is the part to read before you make it your only sink. Duplicates arrive
routinely here — see **At-least-once, and how to deduplicate**, above, for
what to key on at your SIEM.

The scheme decides both the transport and the default port: `tls://` connects on
6514, `tcp://` on 514, and a port written into the URL overrides either.

**`tcp://` is accepted, and discouraged.** It puts the whole audit record —
requester email addresses, IP addresses, document titles — on the network in
cleartext, and it authenticates neither end, so anything that can reach the port
can also write forged audit rows into your SIEM. Use it only where the receiver
sits on a link you already treat as private, such as a sidecar on the same host,
and prefer `tls://` even there.

**There is no UDP, and no variable turns it on.** UDP syslog discards messages
silently under load and has no way to tell you it did, which is exactly the
property a compliance record cannot have. A `udp://` URL is refused at boot
rather than quietly accepted.

### TLS trust for the syslog sink

Syslog to a SIEM is nearly always against a private CA and frequently mutual
TLS, so the trust this sink uses is something you configure rather than
something it assumes.

- `AUDIT_SINK_SYSLOG_CA` is the PEM of the CA that signed the receiver's
  certificate. Set it whenever that CA is not in the container's public trust
  store, which for an internal receiver is always.
- `AUDIT_SINK_SYSLOG_CLIENT_CERT` and `AUDIT_SINK_SYSLOG_CLIENT_KEY` are the
  client certificate a receiver demanding mutual TLS will ask for. Set both or
  neither: one alone refuses to boot, because half a pair is not a weaker
  configuration, it is a handshake that fails on every tick.

**Certificate verification is never disabled, and there is no variable that
disables it.** This is the channel carrying your entire audit record. A switch
for turning verification off would be the first thing reached for on a handshake
error, and that error is almost always a missing `AUDIT_SINK_SYSLOG_CA` rather
than something worth ignoring.

A PEM block is multi-line and a `docker run -e` argument is not, so all three
PEM variables accept `\n` escape sequences and turn them into real newlines:

```sh
AUDIT_SINK_SYSLOG_CA="-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIB…\n-----END CERTIFICATE-----\n"
```

A value that already contains real newlines — from a Compose file, a quoted
multi-line `.env` entry, or a secrets mount read into the environment — passes
through untouched, so you do not have to choose one form.

### What arrives at the receiver

One connection per batch: a message per audit event, a trailing message carrying
the manifest, then the connection is closed. An attestation is its own
connection carrying a single message. Nothing is pooled — with no
acknowledgement to resynchronise on, a half-written batch on a reused socket
would have no defined meaning for the batch after it.

Each message is RFC 5424, framed by RFC 6587 octet counting (`MSG-LEN SP MSG`),
which is the only framing that stays unambiguous over a stream:

```
<133>1 2026-09-04T09:15:22.031Z trust.example.com trustcenter 0193f2c8-… audit - {"id":"…","seq":"41827",…}
```

- **PRI** is the facility times eight plus severity 5, `notice`; with the
  `local0` default, `<133>`. `notice` rather than `info` because a compliance
  record swallowed by a routine `*.info` filter is precisely the failure this
  subsystem exists to prevent.
- **HOSTNAME** is the host of your `BASE_URL`, not the container's hostname. A
  scheduler-assigned container id means nothing to whoever reads the message and
  changes on every deploy.
- **APP-NAME** is always `trustcenter`.
- **PROCID** carries the **batch id**. That is how a receiver correlates the
  rows to the manifest message that follows them. An attestation carries the
  literal `attestation`, since it belongs to no batch.
- **MSGID** is `audit` for a row, `manifest` for the trailing message and
  `attest` for an attestation. Route on it.
- **STRUCTURED-DATA** is nil, `-`. A private structured-data id requires a
  registered enterprise number this project does not have, and PROCID already
  carries the correlation it would have held.
- **MSG** is the same canonical JSON line the S3 sink writes into the `.ndjson`
  object, prefixed with a UTF-8 BOM — RFC 5424 §6.4 makes the BOM how a receiver
  knows the payload is UTF-8. Strip it before parsing the JSON if your receiver
  does not.

`AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` defaults to 8192, matching rsyslog's own
default; raise it only alongside the receiver's own limit. **A row whose message
exceeds it fails the entire batch**, with reason `config`, and no connection is
opened at all. It is not truncated, because a truncated row can never reproduce
its digest, and it is not skipped, because a sink that drops what it cannot send
is silently lossy. The remedy is a setting at one end or the other. The
deployments that meet this are the ones whose audit events carry large `meta`.

### What shipping to a SIEM cannot promise

Three things are true of this sink that are not true of the bucket. None of them
is a defect waiting to be fixed — they follow from a protocol that acknowledges
nothing — and you should know them before an auditor does.

**There is no acknowledgement.** RFC 6587 has none to offer. "Shipped" here
means the bytes were written to a socket and the receiver closed the connection
without complaint, which is materially weaker than a PUT that returned 200. A
receiver whose own queue overflows discards messages silently, and no trace of
that reaches this deployment: the batch is recorded as shipped and the panel
stays green. If you need a record you can demonstrate arrived, the S3 sink is
the one that offers it, and the two run happily together.

**`sha256sum` verification does not apply.** The one-command check under *What
arrives in the bucket* has nothing to run against here. There is no object at
the far end, and once your SIEM has parsed, indexed and normalized the rows an
auditor cannot reconstruct the exact bytes, so cannot reproduce the digest at
all. The `byte_count` and the digest recorded for a syslog shipment describe
**what was sent**, not what was stored. Treat the syslog copy as an operational
feed and the bucket as the evidentiary one.

**A receiver that never closes the connection stalls the batch.** Since nothing
is acknowledged, the receiver closing the connection after we have written and
half-closed is the strongest evidence available that it took the batch, and this
deployment waits for it rather than declaring success the moment the last byte
left. A receiver that instead holds the connection open — some relays keep a
session alive by design — stalls until the thirty-second timeout, and the batch
is retried on the normal backoff even though the bytes arrived. You would see
that as a backlog that keeps growing and `timeout` in the panel, against a
receiver that looks perfectly healthy from its own side. It is the deliberate
choice: the alternative is recording a batch as shipped that the receiver
actually rejected, and a false entry is worse than a duplicate in a record whose
whole value is that it is true.

**A receiver that resets the connection has the same cause and the opposite
symptom.** Some receivers — or an L4 proxy in front of one — end a batch with
`SO_LINGER 0` or an abrupt `destroy()` rather than a clean `end()`, which
arrives here as a connection reset (`ECONNRESET`) after every byte was already
written. It is recorded as `network`, not `timeout` — and rejected for the
same reason as the stall above: a reset after our FIN can just as easily mean
the receiver rejected the batch, so this deployment cannot tell the two apart
and must not guess. In practice the batch was usually delivered whole, so you
would see every batch recorded as failed, retried forever on the normal
backoff, one duplicate landing in your SIEM per retry, and `network` in the
panel against a receiver whose own logs show nothing wrong. Deduplicating on
`id`, above, is what makes this survivable.

### Watching it

**Settings → Integrations** carries a read-only panel: per sink, whether it is
configured, the object-lock status, how many batches are waiting and since when,
what shipped last, the error it is still carrying, and the digest-mismatch
count. Above them, coverage.

A digest mismatch is **expected** after an erasure request and is not an alarm:
the batch was rebuilt without the erased rows, so its bytes no longer match the
digest recorded when it was cut.

If the oldest waiting batch is more than six hours old, a marker appears next to
**Integrations** in the admin navigation, on every admin page. That exists
because this subsystem's failure mode is that the compliance record quietly
stops leaving the box, and on a deployment with no metrics collector — the
default — nothing else would tell you.

With telemetry configured (§11) there are four instruments:
`trustcenter.auditsink.batch` (by sink and outcome),
`trustcenter.auditsink.s3.queue.depth`,
`trustcenter.auditsink.syslog.queue.depth`, and
`trustcenter.auditsink.digest_mismatch`. The two depth gauges are separate
instruments rather than one carrying a `sink` attribute, and both report even
while their sink is switched off, so batches left pending stay visible.

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

These are not promises to take on faith. `tests/e2e/security.spec.ts` asserts
each of them on every run: it records every request the portal makes and fails
on any foreign origin, checks the policy header, and checks the cookie jar is
empty. Run `pnpm test:e2e` against your own build.

## 10. Erasure requests

A requester — someone who asked for a gated document and confirmed their email
address — can be erased from `/admin/requesters/{id}`. Purging is immediate and
**cannot be undone**; nothing keeps a copy of what it cleared.

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

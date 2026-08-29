# Matchory Trust Center

An open-source, self-hostable **Trust Center**: the buyer-facing proof layer that publishes a
company's security, privacy, and compliance posture, gates sensitive documents behind approval and
NDA, and records who accessed what and when. Built with SvelteKit and Postgres, first-class DE/EN
content, no third-party trackers on the public portal.

Licensed under [AGPL-3.0-or-later](./LICENSE).

## Running it

For a real deployment, everything runs from one compose file:

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD, BASE_URL, and the OIDC_* values.
docker compose up -d
```

See [`docs/self-hosting.md`](./docs/self-hosting.md) for every environment variable, worked
Keycloak and Authentik setups, reverse-proxy configuration, and backups.

## Developing

Requires Node 22+, [pnpm](https://pnpm.io), and Docker.

```sh
cp .env.example .env

# Postgres, Mailpit, and a dev OIDC provider for local staff login
docker compose -f compose.dev.yaml up -d --wait

pnpm install
pnpm db:migrate
pnpm dev
```

The app is then served at http://localhost:5173.

## Configuration

See [`docs/self-hosting.md`](./docs/self-hosting.md), or [`.env.example`](./.env.example), for
every environment variable this app reads, with descriptions. One rule worth knowing up front: the locales a deployment can serve are compiled
into the build; `LOCALES` selects which of them are enabled.

## Commands

| Command                     | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `pnpm dev`                  | Start the dev server                                    |
| `pnpm build`                | Build a production version of the app                   |
| `pnpm test:unit`            | Run unit tests                                          |
| `pnpm test:integration`     | Run integration tests against a disposable Postgres     |
| `pnpm test:e2e`             | Run end-to-end tests against a production preview build |
| `pnpm lint` / `pnpm format` | Check / fix formatting and lint issues                  |
| `pnpm check`                | Type-check the project                                  |
| `pnpm db:migrate`           | Apply database migrations                               |
| `pnpm db:generate`          | Generate a migration from schema changes                |

You can preview a production build with `pnpm preview`.

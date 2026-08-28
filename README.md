# Matchory Trust Center

An open-source, self-hostable **Trust Center**: the buyer-facing proof layer that publishes a
company's security, privacy, and compliance posture, gates sensitive documents behind approval and
NDA, and records who accessed what and when. Built with SvelteKit and Postgres, first-class DE/EN
content, no third-party trackers on the public portal.

Licensed under [AGPL-3.0-or-later](./LICENSE).

## Getting started

Requires Node 22+, [pnpm](https://pnpm.io), and Docker.

```sh
cp .env.example .env

# Postgres, Mailpit, and a dev OIDC provider for local staff login
docker compose -f docker-compose.dev.yml up -d --wait

pnpm install
pnpm db:migrate
pnpm dev
```

The app is then served at http://localhost:5173.

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

You can preview a production build with `pnpm preview`.

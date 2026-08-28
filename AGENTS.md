# Vending Machine Middleware

Middleware between TOMOCA / AFen vending machines and Ethiopian payment rails:
EthSwitch IPS ET dynamic QR, and Telebirr checkout for mobile web.

## Stack

- **Language / Runtime**: TypeScript 5.7, Node 22 (no `engines` field declared)
- **Framework**: Express 4, EJS views, Tailwind via CDN
- **Key dependencies**: Prisma 5 + SQLite, Zod, Vitest, swagger-ui-express
- **Package manager**: npm

## Build approach

<TBD, set by /scope>

## Commands

```bash
npm install
npm run dev                # watch mode
npm run build              # compile to dist/, then copy src/views assets
npm test
npm run prisma:push        # apply schema.prisma; prisma:generate after a schema change
npm run pm2:start          # production process, port 19000
```

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title.md`.

## Rules

- Route handlers are `async (req, res): Promise<void>`, wrap the body in try/catch, and send with `res.status(...).json(...)`.
- Two response shapes coexist by audience: `{code, msg}` for vending machine and gateway endpoints, `{success, message}` for web and admin ones. Match the endpoint's neighbours rather than adding a third.
- Reach the database only through the `prisma` singleton in `src/lib/prisma.ts`.
- Order state changes go through `src/services/orderStore.ts`, never raw Prisma in a controller, so status transitions and the SSE broadcast stay in one place.
- Broadcast state changes with `eventBroadcaster.broadcast(...)`. The `/workbench` live feed is how the system is observed while a machine runs.
- Environment reading belongs in `src/config/`. Validate there and fail loudly rather than letting an undefined value travel.
- Anything marking an order paid without a gateway confirming it is a sandbox shortcut. Gate it behind `sandboxPaymentsAllowed()` so it cannot run in production.
- Business logic in `src/services/`, HTTP handling in `src/controllers/`, routes wired directly in `src/app.ts`.

## Gotchas

- `src/routes/` is dead code. Nothing imports it; `src/app.ts` wires every handler itself.
- Middleware order in `src/app.ts` is load bearing: the Telebirr notify route is mounted with `express.raw` before `express.json()` on purpose.
- `views/` and `public/` resolve from the working directory, so the process must start from the project root.

## Agent skills

- [prisma-database-setup](.agents/skills/prisma-database-setup/): `prisma/skills`, configuring Prisma against a database provider
- [prisma-client-api](.agents/skills/prisma-client-api/): `prisma/skills`, Prisma Client queries, filters and CRUD
- [prisma-cli](.agents/skills/prisma-cli/): `prisma/skills`, the `init`, `generate`, `migrate` and `db` commands
- [vitest](.agents/skills/vitest/): `antfu/skills`, Vitest setup and configuration
- [express-typescript](.agents/skills/express-typescript/): `mindrally/skills`, Express patterns in TypeScript
- [zod](.agents/skills/zod/): `pproenca/dot-skills`, Zod schema validation patterns

MCP servers: Prisma MCP (recommended, https://www.prisma.io/mcp) · Vitest MCP (recommended, vitest-community/mcp)

## Context files

- [src/services/telebirr/AGENTS.md](src/services/telebirr/AGENTS.md): Telebirr Fabric gateway, signing rules and the callback trust model
- [src/utils/AGENTS.md](src/utils/AGENTS.md): EMVCo TLV and CRC primitives behind the EthSwitch QR payload

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._

# nook

A template monorepo: a [Foldkit](https://foldkit.dev) frontend, an
[Effect](https://effect.website) RPC backend, and [Alchemy](https://alchemy.run)
for the Cloudflare infrastructure. It ships one feature — a durable counter —
to prove the whole path end to end.

- **Frontend** — `apps/web`, a Foldkit app that renders components installed
  from the [foldcn](https://foldcn.elianiva.com) registry.
- **Backend** — `packages/api`, Effect RPC handlers over a Cloudflare KV
  namespace. The contract lives in `packages/shared`.
- **Infrastructure** — `alchemy.run.ts`, one `Cloudflare.Website.Foldkit` with a
  custom Worker entry and a KV binding, deployed to `nook.elianiva.com`.

## Layout

```
apps/web        @nook/web     Foldkit client + the Worker entry (src/worker.ts)
packages/api    @nook/api     Effect RPC handlers and the KV-backed service
packages/shared @nook/shared  The RPC contract (effect Schema + Rpc)
alchemy.run.ts               The Cloudflare stack
```

## Requirements

- Node.js >= 24
- pnpm 12
- A Cloudflare account. Alchemy reads `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, or an `alchemy` login from `~/.alchemy`.

## Commands

```bash
pnpm install        # install the workspace
pnpm dev            # alchemy dev: the Worker and the Foldkit client on one port
pnpm check          # vp check: format, lint, and type-check
pnpm test           # turbo test
pnpm build          # turbo build
pnpm infra:deploy   # alchemy deploy --stage prod --yes
```

## The counter

`GetCounter`, `ChangeCounter`, and `ResetCounter` are the whole API
(`packages/shared/src/counter.ts`). The Worker mounts the group at `/api/rpc`
(`apps/web/src/worker.ts`), and `CounterServiceLive` reads and writes the
`count` key in the `COUNTER` KV namespace. KV has no atomic increment, so a
change is a read-modify-write — fine for a template, and the place to swap in a
Durable Object when it is not.

## Installing more foldcn components

`apps/web/components.json` registers the foldcn namespace. Add components from
`apps/web`:

```bash
pnpm dlx shadcn@latest add @foldcn/dialog
```

The base style (`@foldcn/foldcn`) is already installed, so its theme variables
are in `apps/web/src/styles.css`.

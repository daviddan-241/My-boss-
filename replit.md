# DexScreener Boost Tracker

A live DexScreener boost tracker with a Telegram bot for volume boosting services across multiple chains (Solana, Ethereum, BNB, Base, TON).

## Run & Operate

- `pnpm --filter @workspace/dex-boost-tracker run dev` — run the frontend (port 5000)
- `pnpm --filter @workspace/api-server run dev` — build and run the API server + Telegram bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned)
- Required env: `PORT` — server port (set to 5000)
- Required env: `BASE_PATH` — vite base path (set to /)
- Optional env: `TELEGRAM_BOT_TOKEN` — enables the Telegram bot
- Optional env: `PAYMENT_WALLET_SOL`, `PAYMENT_WALLET_EVM`, `PAYMENT_WALLET_TON` — payment wallets
- Optional env: `ADMIN_CHAT_ID` — Telegram admin chat for order notifications

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite 7 + Tailwind CSS 4 + shadcn/ui
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/dex-boost-tracker/` — React frontend (live boost tracker UI)
- `artifacts/api-server/` — Express API server + Telegram bot
- `lib/db/` — Drizzle ORM schema and DB client
- `lib/api-spec/` — OpenAPI spec source
- `lib/api-zod/` — Zod schemas generated from OpenAPI spec
- `lib/api-client-react/` — React Query hooks generated from OpenAPI spec

## Architecture decisions

- Frontend talks directly to DexScreener API from the browser (no proxy needed)
- Telegram bot runs via polling inside the API server process
- DB schema is empty by default; add tables to `lib/db/src/schema/index.ts`
- API server uses esbuild to bundle all workspace libs into a single `.mjs` file
- Deployment uses VM target (always-running) to keep the Telegram bot alive

## Product

- **Live Boost Tracker**: Real-time dashboard showing latest and top boosted tokens on DexScreener with 30s auto-refresh, chain filtering, and search
- **Telegram Bot**: Multi-step bot for purchasing volume boost packages, DEX update/ads/trending services, supply locking, and token burning across 5 chains

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The vite config requires `PORT` and `BASE_PATH` env vars at startup — both are set in shared env
- The API server dev script builds first before starting (`pnpm run build && pnpm run start`)
- Telegram bot only starts if `TELEGRAM_BOT_TOKEN` is set; absence is logged as a warning
- `node-telegram-bot-api` has a missing peer dep warning (`request@^2.34`) — safe to ignore

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- DexScreener boost endpoints: `/token-boosts/latest/v1` and `/token-boosts/top/v1`

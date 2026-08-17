# DexBoost 🦅 — Token Growth Services Bot

A Telegram bot + web dashboard for DexScreener boost feeds, multi-source token
lookup, and paid token-growth services with **real on-chain payment
verification** — orders are confirmed only when the actual transaction lands.

> ⚠️ **Safety note:** this bot never asks for seed phrases, private keys, or
> wallet credentials. Any bot or service that does is a scam — never share
> them with anyone. Real wallet operations happen by connecting a wallet and
> signing; this bot has no credential flows at all.

## What it does

**Telegram bot** (`@YourBot` after you deploy):
| Command | Description |
|---|---|
| `/start` | Main menu — lookup, services, orders |
| `/lookup <CA or name>` | Multi-source token lookup (7 sources, EVM chain auto-detect) |
| `/order` | Your latest order status |
| `/latest` · `/top` · `/golden` | DexScreener boost feeds |
| `/chains` | Supported chains & address formats |
| `/orders` · `/approve` · `/reject` · `/wallet` · `/status` | Admin toolkit |

**Paid service flows** (real order lifecycle):
- 📦 **Volume packages** — 5 tiers + custom, priced per chain in native tokens
- 📊 **DEX Update** — fixed USD price converted to chain-native
- 📣 **DEX Ads** — hourly rates, community-group collection
- 🔥 **DEX Trending** — Top 10 / Top 3 tiers

Every order gets an ID, a receiving wallet, an expiry window, and automatic
**on-chain payment detection** (Ethereum/BSC/Base via Etherscan-V2 /
Blockscout / RPC balance-delta; Solana via RPC; TON via TonCenter). Payment
confirmed → admin notified with the tx link → admin approves → user gets the
completion message. Expired/cancelled/rejected states are all handled and
reported honestly.

**Admin visibility** (all real events hit `ADMIN_CHAT_ID`): new users,
orders created, payments confirmed (with tx link), unmatched/underpaid
deposits, expired orders, and bot online/offline status.

**Lookup engine**: results always try every source — DexScreener, PumpFun,
GeckoTerminal, CoinGecko, Birdeye, Jupiter, Moralis **and the Solana chain
itself** (Metaplex metadata + pump.fun bonding-curve read directly from the
RPC — resolves ANY mint that ever existed, including months-old pump.fun
coins, token-2022 mints and dead pools). Token logos are included
(image-enrichment pass), and a fast-path races the sources so answers arrive
in ~1.5s even when one API is rate-limiting. Old/inactive coins resolve
because contract-based sources don't depend on recent trading activity.

**Web dashboard** (`artifacts/dex-boost-tracker`) — React app showing
latest/top boosted tokens with 30s auto-refresh, chain filters, search and a
token detail modal.

**Web dashboard** (`artifacts/dex-boost-tracker`) — React app showing
latest/top boosted tokens with 30s auto-refresh, chain filters, search and a
token detail modal. Reads DexScreener's public API directly from the browser.

## Token lookup — multi-source engine

Lookups fan out in parallel and merge results, so a token missed by one API is
caught by another:

1. **DexScreener** (primary — richest market data)
2. **PumpFun** (Solana bonding-curve tokens)
3. **GeckoTerminal** (direct lookup + EVM network probing for auto chain detection)
4. **CoinGecko** (price / market cap / volume per platform)
5. **Birdeye** (optional — set `BIRDEYE_API_KEY`)
6. **Jupiter** (Solana metadata fallback)
7. **Moralis** (optional — set `MORALIS_API_KEY`)

With per-source rate limiting, retries with exponential backoff + jitter,
per-attempt timeouts, and a short-TTL cache (5 min default) so repeated
lookups don't hammer upstream APIs. Failures report **which sources were tried
and why**, instead of a bare "token not found".

## Stack

- pnpm workspaces · Node 20 · TypeScript 5.9
- API: Express 5 + `node-telegram-bot-api` (webhook **or** long polling)
- Persistence: optional Postgres (sessions survive restarts; table auto-created)
- Frontend: React 19 + Vite 7 + Tailwind 4 (shadcn/ui)
- Build: esbuild single-file bundle (`artifacts/api-server/dist/index.mjs`)
- Observability: pino JSON logs, `/api/healthz` + `/api/health/bot` (bot status,
  uptime, session count, per-source lookup stats)

## Quick start (local dev)

```bash
corepack enable
pnpm install --frozen-lockfile

# 1) API server + bot (polling mode, no webhook needed)
TELEGRAM_BOT_TOKEN=123:abc PORT=5000 ADMIN_CHAT_ID=123 \
  PAYMENT_WALLET_SOL=YOURSOLWALLET PAYMENT_WALLET_EVM=0xYOURWALLET \
  pnpm --filter @workspace/api-server run dev

# 2) Web dashboard (separate terminal)
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/dex-boost-tracker run dev
```

Health endpoints: `http://localhost:5000/api/healthz` and `/api/health/bot`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ (production) | Bot token from @BotFather |
| `PORT` | ✅ | HTTP port (platforms inject it) |
| `ADMIN_CHAT_ID` | recommended | Enables admin commands + order alerts |
| `PAYMENT_WALLET_SOL` / `_EVM` / `_TON` | for paid flows | Receiving wallets; paid flows disabled until set |
| `DATABASE_URL` | optional | Postgres — sessions **and orders** persist (tables auto-created). Without it, orders persist in `./data/orders.json` (restarts, not deploys) |
| `ETHERSCAN_API_KEY` / `BSCSCAN_API_KEY` / `BASESCAN_API_KEY` | optional | Etherscan V2 (free keys; fallback: keyless Blockscout / RPC balance-delta) |
| `TONCENTER_API_KEY` | optional | TonCenter rate limits |
| `SOLANA_RPC_URL` | optional (recommended) | Powers the on-chain Solana source (metadata + bonding curve). Defaults to public RPCs; a free Helius/QuickNode RPC is strongly recommended for speed |
| `WEBHOOK_URL` / `WEBHOOK_SECRET_PATH` / `WEBHOOK_SECRET_TOKEN` | optional | Webhook mode (polling by default — better on sleeping free tiers) |
| `DEX_UPDATE_PRICE_USD` + `DEX_UPDATE_SOL/ETH/BNB/TON` | optional | DEX-update pricing (defaults 299 → 2/0.1/0.5/75) |
| `ORDER_EXPIRY_HOURS` / `PAYMENT_POLL_INTERVAL_MS` | optional | Order window (24h) / deposit poll (45s) |
| `KEEPALIVE_URL` / `KEEPALIVE_INTERVAL_MS` | optional | Self-ping (external cron is the real keep-alive on free tiers) |
| `BIRDEYE_API_KEY` / `COINGECKO_API_KEY` / `MORALIS_API_KEY` | optional | Lookup API keys |

Configuration is validated at boot — missing/invalid values fail fast with a
clear message instead of a silent outage.

## Deploying

Full guide in **[DEPLOY.md](./DEPLOY.md)** — including the **Render free +
UptimeRobot** setup this repo ships with (`render.yaml`), the free **Neon
Postgres** for persistence, and the paid always-on upgrade path. Also
included: `Dockerfile`, `railway.toml`, `fly.toml`.

## Repository layout

- `artifacts/api-server/src/lib/telegramBot.ts` — the bot (lookups, service flows, admin toolkit)
- `artifacts/api-server/src/lib/tokenLookup.ts` — multi-source lookup engine
- `artifacts/api-server/src/lib/paymentVerifier.ts` — on-chain payment verification (EVM/Solana/TON) + watcher
- `artifacts/api-server/src/lib/orderStore.ts` — persistent orders (Postgres / file / memory)
- `artifacts/api-server/src/lib/sessionStore.ts` — persistent sessions (Postgres / memory)
- `artifacts/dex-boost-tracker/` — React dashboard
- `lib/db/` — Drizzle schema mirrors (`bot_sessions`, `orders`)
- `lib/api-spec/`, `lib/api-zod/`, `lib/api-client-react/` — OpenAPI codegen chain

## Scripts

```bash
pnpm run typecheck   # full typecheck
pnpm run build       # typecheck + build all packages
pnpm --filter @workspace/api-server run build   # bundle server → dist/index.mjs
pnpm --filter @workspace/scripts run smoke            # multi-source lookup smoke test (live APIs)
pnpm --filter @workspace/scripts run smoke-payments   # payment verification logic tests
pnpm --filter @workspace/db run push            # (optional) drizzle-kit schema push
```

# DexBoost — Token Growth Services Bot

A Telegram bot with multi-source token lookup, DexScreener boost feeds, and
paid token-growth services with **real on-chain payment verification**
(Ethereum/BSC/Base via Etherscan-V2/Blockscout/RPC, Solana via RPC, TON via
TonCenter). No seed phrases, no private keys — ever.

## Run & Operate

- `pnpm --filter @workspace/dex-boost-tracker run dev` — run the frontend (port 5000)
- `pnpm --filter @workspace/api-server run dev` — build and run the API server + Telegram bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/scripts run smoke` — lookup engine smoke test
- `pnpm --filter @workspace/scripts run smoke-payments` — payment logic tests

Required env:
- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather (fail-fast in production)
- `PORT` — server port (5000 locally)

Payment + orders env:
- `PAYMENT_WALLET_SOL` / `PAYMENT_WALLET_EVM` / `PAYMENT_WALLET_TON` — receiving wallets
- `DATABASE_URL` — Postgres; sessions + orders persist (tables auto-created).
  Without it, orders persist in `./data/orders.json` (survives restarts).
- `ETHERSCAN_API_KEY` / `BSCSCAN_API_KEY` / `BASESCAN_API_KEY` / `TONCENTER_API_KEY` / `SOLANA_RPC_URL` — optional verification keys (keyless fallbacks exist)

Other optional env:
- `ADMIN_CHAT_ID` — enables /orders /approve /reject /wallet /status
- `WEBHOOK_URL` (+ `_SECRET_PATH`, `_SECRET_TOKEN`) — webhook mode; polling is default and better on sleeping free tiers
- `KEEPALIVE_URL` / `KEEPALIVE_INTERVAL_MS` — self-ping (external cron is the real keep-alive)
- `DEX_UPDATE_PRICE_USD` + `DEX_UPDATE_SOL/ETH/BNB/TON` — DEX-update pricing
- `ORDER_EXPIRY_HOURS`, `PAYMENT_POLL_INTERVAL_MS` — order window / deposit poll

## Where things live

- `artifacts/api-server/src/lib/telegramBot.ts` — the bot (flows, commands, admin toolkit)
- `artifacts/api-server/src/lib/tokenLookup.ts` — multi-source lookup engine
- `artifacts/api-server/src/lib/paymentVerifier.ts` — on-chain deposit verification + watcher
- `artifacts/api-server/src/lib/orderStore.ts` — persistent orders (PG / file / memory)
- `artifacts/api-server/src/lib/sessionStore.ts` — persistent sessions (PG / memory)
- `artifacts/dex-boost-tracker/` — React boost tracker dashboard
- `lib/db/` — Drizzle schema mirrors (`bot_sessions`, `orders`)

## Deploying

See **DEPLOY.md** — Render free + UptimeRobot pairing, Neon free Postgres,
payment verification tiers, admin commands, and the paid always-on upgrade.
`Dockerfile`, `railway.toml`, `fly.toml` included for other hosts.

## Gotchas

- The api-server dev script builds first before starting
- Bot starts in polling mode unless `WEBHOOK_URL` is set — keep polling on Render free
- `pg` is externalized in the esbuild bundle — it must be in production node_modules (the Dockerfile's `pnpm deploy` step handles this)
- Order IDs are short codes (e.g. `DB-8F3K2A`) — quote them in /order, /approve, /reject
- `node-telegram-bot-api` has a missing peer dep warning (`request@^2.34`) — safe to ignore

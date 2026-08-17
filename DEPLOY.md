# Deploying DexBoost — Render free + UptimeRobot (your current stack)

This guide matches the setup you're running: **Render free web service kept
awake by UptimeRobot**, with real on-chain payment verification.

## What's real now

| Before | Now |
|---|---|
| "✅ Payment Sent" button (no verification) | The bot watches the blockchain and confirms payment only when a real transaction arrives (Ethereum/BSC/Base via Blockscout/Etherscan-V2, Solana via RPC, TON via TonCenter) |
| Orders lost on restart | Orders persist (Postgres or `./data/orders.json`); a restart mid-payment loses nothing |
| "Hold on… we're confirming" dead-end | Real order lifecycle: awaiting_payment → paid → fulfilled/rejected/expired, with status updates and `/order` |
| Sessions in RAM only | Sessions persist with `DATABASE_URL` |
| Deprecated Etherscan V1 calls | Three-tier EVM verification: keyed V2 → keyless Blockscout → keyless RPC balance-delta |

**Still never:** seed phrases, private keys, or wallet credentials. No
legitimate service asks for those — real wallet operations happen by
connecting a wallet and signing, not by pasting phrases into chat. This bot
does not ask.

## 1. Create the database (free)

Render's own free Postgres **expires after 30 days** — use Neon instead:

1. Sign up at **neon.tech** (free tier, no card).
2. Create a project → copy the connection string, e.g.
   `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`.
3. Tables (`bot_sessions`, `orders`) are created automatically at boot — no
   migration step needed.

## 2. Deploy on Render (free)

1. Render dashboard → **New → Blueprint** → pick this repo → Apply.
   `render.yaml` uses `plan: free` on purpose.
2. Add env vars in the dashboard (see `render.yaml` for the full list):
   - `TELEGRAM_BOT_TOKEN` — **required**, from @BotFather
   - `ADMIN_CHAT_ID` — your chat id (ask @userinfobot) — enables `/orders`,
     `/approve`, `/reject`, `/wallet`, `/status`
   - `PAYMENT_WALLET_SOL` / `PAYMENT_WALLET_EVM` / `PAYMENT_WALLET_TON` —
     your receiving wallets (paid flows are disabled until set)
   - `DATABASE_URL` — the Neon string from step 1
3. **Do NOT set `WEBHOOK_URL`** on the free tier — polling recovers from
   sleeps instantly on wake; webhooks have a finite Telegram retry window and
   can lose updates while the app sleeps.

## 3. Keep it awake with UptimeRobot (free)

1. **uptimerobot.com** → New monitor → type **HTTP(S)**.
2. URL: `https://<your-app>.onrender.com/api/healthz`
3. Interval: **5 minutes** (free plan minimum).
4. That's it — the instance stays warm. Expect ~20–60s cold-start latency
   after any real sleep; the bot's lookup cache + payment catch-up tick make
   that harmless.

> A sleeping instance cannot wake itself (in-app `KEEPALIVE_URL` self-pings
> only help hosts that kill idle connections). The external monitor above is
> the mechanism that actually works on Render free.

## 4. Verify it's live

1. `GET /api/healthz` → `{"status":"ok"}`.
2. `GET /api/health/bot` → bot mode, uptime, sessions, open orders, per-source
   lookup stats.
3. In Telegram: `/start`, then `/lookup So11111111111111111111111111111111111111112`
   → "✅ Token Found".
4. Start a volume order, send the exact amount, and watch: the bot confirms
   the real on-chain tx in chat (usually within one poll, 45s default) and
   DMs you with a ✅ Approve button. Tap Approve → the user gets the
   "completed" message.

## 5. Payment verification tiers (how "real" works)

**Ethereum / Base**
1. Etherscan V2 if `ETHERSCAN_API_KEY` / `BASESCAN_API_KEY` is set (free key)
2. else Blockscout public API (keyless, full tx detail)
3. else public RPC balance-delta (keyless; detects net inflow, no tx hash)

**BNB Chain** — Etherscan V2 with `BSCSCAN_API_KEY`, else public-RPC
balance-delta (no keyless Blockscout exists for BSC).

**Solana** — `getSignaturesForAddress` + `getTransaction` on
`SOLANA_RPC_URL` (default public mainnet; a free Helius/QuickNode key is
recommended for reliability).

**TON** — TonCenter v2 `getTransactions` (free; optional `TONCENTER_API_KEY`).
Friendly (`EQ…`), bare-base64, and raw (`0:…`) wallet formats all supported.

Matching rules: destination wallet + value ≥ 99.5% of the order amount +
timestamp within the order window. Partial payments are rejected by the
matcher and only visible to you via the chain — refunds/manual fixes are your
admin call.

**Admin DMs cover everything real**: every new user who opens the bot,
every order created, every confirmed payment (with explorer link + inline
Approve/Reject buttons), every **unmatched deposit** (wrong amount / late
payment — includes amount and tx link), expiries, and bot online/offline
pings.

**Lookups always try everywhere** — DexScreener, PumpFun, GeckoTerminal,
CoinGecko, Birdeye, Jupiter, Moralis, **plus the Solana chain itself**: token
metadata (Metaplex) and the pump.fun bonding-curve state are read directly
from the RPC, so ANY Solana mint that ever existed resolves — months-old
pump.fun coins, token-2022 mints, dead pools. Results include the token logo,
and a fast-path races sources so answers land in ~1.5s even when one API is
rate-limiting.

**New env (optional):** `SOLANA_RPC_URL` — powers the on-chain source.
Defaults to public RPCs (fine), but a **free Helius or QuickNode RPC** is
strongly recommended for speed and reliability. All other env vars are
unchanged from before.

**Built-in self-warm keep-alive**: the server pings its own `/api/healthz`
every 5 minutes by default (override with `KEEPALIVE_URL`). This keeps the
process warm but cannot wake a *slept* instance — that's what the UptimeRobot
monitor does. Combined, the bot stays up.

## 6. Admin commands

| Command | What it does |
|---|---|
| `/orders` | Last 10 orders with status |
| `/order DB-XXXX` | Order detail + Approve/Reject buttons |
| `/approve DB-XXXX` | Mark paid order completed → user notified 🎉 |
| `/reject DB-XXXX [reason]` | Reject with optional reason → user notified |
| `/wallet` | Show configured wallets + DEX-update pricing |
| `/status` | Bot mode, uptime, open orders, lookup stats |

## 7. Pricing config

- Volume packages: hardcoded in `telegramBot.ts` (`PACKAGES`).
- DEX Update: `DEX_UPDATE_PRICE_USD` (default 299) converted per chain via
  `DEX_UPDATE_SOL/ETH/BNB/TON` (defaults 2 / 0.1 / 0.5 / 75 — update these as
  markets move; `/wallet` shows the current effective values).
- Ads / trending rates: `adsRateFor` / `trendingRateFor` in `telegramBot.ts`.
- `ORDER_EXPIRY_HOURS` (default 24) — payment window.
- `PAYMENT_POLL_INTERVAL_MS` (default 45s).

## 8. Upgrading later (when you want zero cold starts)

Swap `plan: free` → `plan: starter` in `render.yaml` ($7/mo), delete the
UptimeRobot monitor (or keep it as external monitoring), optionally set
`WEBHOOK_URL=https://<app>.onrender.com` + `WEBHOOK_SECRET_TOKEN` for webhook
mode. Everything else stays identical. `Dockerfile`, `railway.toml` and
`fly.toml` are also in the repo for other hosts.

## 9. Local dev

```bash
corepack enable
pnpm install --frozen-lockfile
TELEGRAM_BOT_TOKEN=123:abc PORT=5000 ADMIN_CHAT_ID=123 \
  pnpm --filter @workspace/api-server run dev
```

Tests: `pnpm --filter @workspace/scripts run smoke` (multi-source lookups),
`pnpm --filter @workspace/scripts run smoke-payments` (payment logic).

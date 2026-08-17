/**
 * Smoke test for the payment verification logic (pure functions, no network).
 *
 * Run:  pnpm --filter @workspace/scripts run smoke-payments
 *
 * Verifies:
 *   1. EVM tx-list filtering (only successful plain transfers INTO the wallet)
 *   2. Minimum-accepted-amount math (99.5% rule)
 *   3. Deposit/order matching (amount + time window)
 *   4. TON address normalization (friendly EQ… ↔ raw 0:…)
 */

import {
  depositMatchesOrder,
  filterEvmTxList,
  minAcceptedSmallestUnits,
  tonAddressMatches,
  tonNormalize,
} from "../artifacts/api-server/src/lib/paymentVerifier.js";
import type { Order } from "../artifacts/api-server/src/lib/orderStore.js";

let failures = 0;

function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

function makeOrder(amountSmallest: string, createdAt = Date.now() - 60_000): Order {
  return {
    id: "DB-TEST01",
    userId: 1,
    chatId: 1,
    service: "volume",
    packageName: "BASIC",
    token: { symbol: "TST", name: "Test", chain: "Ethereum", chainId: "ethereum", address: "0xabc" },
    amount: 1,
    amountSmallest,
    currency: "ETH",
    chainId: "ethereum",
    wallet: "0xRECV",
    status: "awaiting_payment",
    createdAt,
    expiresAt: Date.now() + 3_600_000,
  };
}

async function main(): Promise<void> {
  // 1. EVM filter (both Etherscan-family and Blockscout shapes)
  console.log("\n=== EVM tx-list filtering ===");
  const wallet = "0x1111111111111111111111111111111111111111";
  const txs = [
    { hash: "0xa1", from: "0xsender", to: wallet, value: "1000000000000000000", input: "0x", isError: "0", timeStamp: "1700000000" }, // 1 ETH ✓ (etherscan shape)
    { hash: "0xa2", from: "0xsender", to: wallet.toUpperCase(), value: "1000000000000000000", input: "0x", isError: "0", timeStamp: "1700000000" }, // case-insensitive ✓
    { hash: "0xa3", from: "0xsender", to: "0xOTHER", value: "1000000000000000000", input: "0x", isError: "0", timeStamp: "1700000000" }, // wrong dest ✗
    { hash: "0xa4", from: "0xsender", to: wallet, value: "1000000000000000000", input: "0x1234abcd", isError: "0", timeStamp: "1700000000" }, // contract call ✗
    { hash: "0xa5", from: "0xsender", to: wallet, value: "1000000000000000000", input: "0x", isError: "1", timeStamp: "1700000000" }, // failed ✗
    { hash: "0xa6", from: "0xsender", to: wallet, value: "0", input: "0x", isError: "0", timeStamp: "1700000000" }, // zero value ✗
    { hash: "0xa7", from: { hash: "0xsender" }, to: { hash: wallet }, value: "500000000000000000", raw_input: "0x", result: "success", timestamp: "2026-08-14T09:45:59.000000Z" }, // blockscout shape ✓
    { hash: "0xa8", from: { hash: "0xsender" }, to: { hash: wallet }, value: "100000000000000000", raw_input: "0x", result: "failed", timestamp: "2026-08-14T09:45:59.000000Z" }, // blockscout failed ✗
  ];
  const deposits = filterEvmTxList(txs, wallet, "https://etherscan.io");
  check("keeps valid native transfers (both shapes)", deposits.length === 3);
  check("etherscan-shape amount parsed as wei string", deposits[0]?.amountSmallest === "1000000000000000000");
  check("blockscout-shape amount parsed", deposits.some((d) => d.amountSmallest === "500000000000000000"));
  check("blockscout-shape timestamp parsed", deposits.some((d) => d.timestamp === Date.parse("2026-08-14T09:45:59.000000Z")));
  check("link built", deposits[0]?.link === `https://etherscan.io/tx/${deposits[0]?.txHash}`);

  // 2. Minimum accepted amount (99.5%)
  console.log("\n=== Amount tolerance ===");
  const order1Eth = makeOrder("1000000000000000000"); // 1 ETH
  check("99.5% accepted", minAcceptedSmallestUnits(order1Eth) === 995000000000000000n);
  check("99.5% deposit matches", depositMatchesOrder(order1Eth, { txHash: "h", from: "f", amountSmallest: "995000000000000000", timestamp: Date.now() }));
  check("99.4% deposit rejected", !depositMatchesOrder(order1Eth, { txHash: "h", from: "f", amountSmallest: "994000000000000000", timestamp: Date.now() }));

  // 3. Time window
  console.log("\n=== Time window ===");
  check("old deposit rejected", !depositMatchesOrder(order1Eth, { txHash: "h", from: "f", amountSmallest: "1000000000000000000", timestamp: order1Eth.createdAt - 120_000 }));
  check("future-dated deposit rejected", !depositMatchesOrder(order1Eth, { txHash: "h", from: "f", amountSmallest: "1000000000000000000", timestamp: Date.now() + 5 * 60_000 }));

  // 4. TON address normalization — fixtures verified against TonCenter
  console.log("\n=== TON addresses ===");
  const tonBare = "EQC3PpxZ-FOvdt9SoHOrrz6cZdvrxMZRxU3MS_M478dq_Uch"; // TonCenter in_msg.destination form (48 chars)
  const tonRaw = "0:b73e9c59f853af76df52a073abaf3e9c65dbebc4c651c54dcc4bf338efc76afd";
  check("raw form normalizes to lowercase", tonNormalize(tonRaw.toUpperCase()) === tonRaw);
  check("raw forms match case-insensitively", tonAddressMatches(tonRaw.toUpperCase(), tonRaw));
  check("bare b64 form decodes to raw", tonNormalize(tonBare) === tonRaw);
  check("bare vs raw match", tonAddressMatches(tonBare, tonRaw));
  check("friendly EQ… form decodes to raw", tonNormalize("EQ" + tonBare) === tonRaw);
  check("friendly vs bare match", tonAddressMatches("EQ" + tonBare, tonBare));
  check("friendly vs raw match", tonAddressMatches("EQ" + tonBare, tonRaw));
  check("different address does not match", !tonAddressMatches("EQ" + tonBare, tonRaw.slice(0, 10) + "f".repeat(56)));

  console.log(failures === 0 ? "\n✅ All payment logic checks passed" : `\n⚠️ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});

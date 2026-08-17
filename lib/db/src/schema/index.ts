/**
 * Database schema.
 *
 * The api-server stores Telegram bot sessions via plain SQL (see
 * lib/sessionStore.ts in artifacts/api-server) and self-creates its table at
 * boot. This Drizzle definition mirrors that table so the schema stays in one
 * place and `pnpm --filter @workspace/db run push` works if you prefer
 * drizzle-kit migrations.
 */

import { pgTable, text, bigint, jsonb, timestamp } from "drizzle-orm/pg-core";

export const botSessionsTable = pgTable("bot_sessions", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  step: text("step").notNull().default("idle"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Mirror of the orders table managed by artifacts/api-server/src/lib/orderStore.ts. */
export const ordersTable = pgTable("orders", {
  id: text("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export type BotSessionRow = typeof botSessionsTable.$inferSelect;
export type OrderRow = typeof ordersTable.$inferSelect;

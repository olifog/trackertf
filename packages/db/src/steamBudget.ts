/**
 * Client side of the Postgres-backed Steam API budget broker.
 *
 * The single Steam API key is shared by four independent processes — the
 * crawler, the server scanner, the match sampler, and the web app's on-demand
 * vanity lookup. Each used to run its own in-process token bucket, so there was
 * no GLOBAL ceiling (their rates simply added up, risking the ~100k/day ToS
 * budget) and no fairness. `takeSteamBudget` replaces that with a shared gate:
 * before every API round-trip a process calls the atomic SQL function
 * `steam_budget_take(class)`, which refills and debits a hierarchical token
 * bucket (per-class floors + a shared surplus pool — see schema.ts
 * `steamBudget`). The sum of the floors and the shared refill is the whole
 * key's ceiling, so the combined rate across all processes can never exceed it,
 * while each class keeps a guaranteed minimum rate (no starvation) and can
 * borrow spare capacity when others are idle.
 *
 * Failure policy: if the broker/DB is unreachable this FAILS OPEN (returns
 * immediately) — the caller's in-process TokenBucket remains as a per-process
 * safety cap, so a database hiccup can never wedge the crawler.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./index.ts";

export type SteamBudgetClass = "crawler" | "scanner" | "sampler" | "web";

export interface TakeOptions {
  /**
   * Give up waiting after this many ms and proceed anyway (fail-open). Use for
   * latency-sensitive interactive calls (the web fast lane) where hanging is
   * worse than a rare budget overshoot. Omit (Infinity) for the background
   * workers, which must always respect the ceiling.
   */
  maxWaitMs?: number;
  /** cap on a single sleep between retries (default 1000ms) */
  pollCapMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Block until this rate class is permitted one Steam API call, then return.
 * Loops on the SQL gate, sleeping the exact time until a token is available.
 */
export async function takeSteamBudget(
  db: Db,
  rateClass: SteamBudgetClass,
  opts: TakeOptions = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? Number.POSITIVE_INFINITY;
  const pollCapMs = opts.pollCapMs ?? 1000;
  const started = Date.now();

  for (;;) {
    let ok = false;
    let waitMs = 250;
    try {
      const rows = (await db.execute(
        sql`select ok, wait_ms from steam_budget_take(${rateClass})`,
      )) as unknown as { ok: boolean; wait_ms: number }[];
      const row = rows[0];
      ok = row?.ok === true;
      waitMs = Math.max(1, Number(row?.wait_ms ?? 250));
    } catch {
      // broker unreachable → fail open; the local TokenBucket still caps us.
      return;
    }
    if (ok) return;
    // Bounded waiters (web) give up and proceed rather than hang the request.
    if (Number.isFinite(maxWaitMs) && Date.now() - started + waitMs > maxWaitMs) return;
    await sleep(Math.min(waitMs, pollCapMs));
  }
}

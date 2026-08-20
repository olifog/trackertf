/**
 * Constructs a SteamClient whose every API round-trip is gated by the shared
 * Postgres budget broker (see @trackertf/db `takeSteamBudget`). The three
 * crawler processes (crawler / scanner / sampler) all build their client this
 * way, so their combined call rate is held under the single key's global
 * ceiling with per-class fairness — replacing the old independent, uncoordinated
 * per-process token buckets. The local ratePerSecond stays as a per-process
 * safety cap for when the broker/DB is unreachable (the gate fails open).
 */
import type { Db, SteamBudgetClass } from "@trackertf/db";
import { takeSteamBudget } from "@trackertf/db";
import { SteamClient } from "@trackertf/steam";
import { record } from "./metrics.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

/**
 * `localRatePerSecond` is only the fallback cap (used if the DB gate is down);
 * it should be >= the class's expected broker rate so it never binds tighter
 * than the broker in normal operation. Defaults to the global ceiling.
 */
export function createBudgetedSteamClient(
  db: Db,
  rateClass: SteamBudgetClass,
  localRatePerSecond = 1.15,
): SteamClient {
  return new SteamClient({
    apiKey: apiKey as string,
    ratePerSecond: localRatePerSecond,
    onResult: record,
    beforeCall: () => takeSteamBudget(db, rateClass),
  });
}

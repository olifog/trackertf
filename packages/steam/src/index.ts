import type { z } from "zod";
import { TokenBucket } from "./ratelimit.ts";
import {
  type BackpackItem,
  type FakeIpPlayer,
  type Friend,
  type GameServer,
  type PlayerSummary,
  getFriendListResponse,
  getOwnedGamesResponse,
  getPlayerBansResponse,
  getPlayerItemsResponse,
  getPlayerSummariesResponse,
  getNumberOfCurrentPlayersResponse,
  getServerListResponse,
  getUserStatsResponse,
  queryByFakeIpPlayersResponse,
  queryByFakeIpRulesResponse,
  resolveVanityResponse,
} from "./schemas.ts";

export { TokenBucket } from "./ratelimit.ts";
export type { BackpackItem, FakeIpPlayer, Friend, GameServer, PlayerSummary };

const BASE = "https://api.steampowered.com";

/**
 * Discriminated fetch outcome. `private` covers every "data exists but we
 * can't see it" shape Steam uses (HTTP 400/401/403/503, status 8/15/18,
 * empty stats) so callers can record privacy rates uniformly.
 */
export type SteamResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "private" }
  | { kind: "not_found" }
  | { kind: "empty" }
  | { kind: "error"; status: number | undefined; message: string };

export interface SteamClientOptions {
  apiKey: string;
  /** Whole-key budget: 100k/day ≈ 1.15/s. Default stays safely under. */
  ratePerSecond?: number;
  fetchImpl?: typeof fetch;
  /** observability hook, called after every API round-trip */
  onResult?: (endpoint: string, outcome: string) => void;
  /**
   * Cross-process admission gate, awaited before every API round-trip (and
   * before the in-process TokenBucket). This is where the Postgres-backed
   * budget broker (see @trackertf/db `takeSteamBudget`) enforces the GLOBAL
   * rate ceiling and per-class fairness across the crawler/scanner/sampler/web
   * processes that share the single API key. The local TokenBucket stays as a
   * per-process safety cap for when the broker/DB is unreachable. Left unset,
   * the client behaves exactly as before (local bucket only).
   */
  beforeCall?: (endpoint: string) => Promise<void>;
}

export class SteamClient {
  readonly #key: string;
  readonly #bucket: TokenBucket;
  readonly #fetch: typeof fetch;
  readonly #onResult: ((endpoint: string, outcome: string) => void) | undefined;
  readonly #beforeCall: ((endpoint: string) => Promise<void>) | undefined;

  constructor(opts: SteamClientOptions) {
    this.#key = opts.apiKey;
    this.#bucket = new TokenBucket({ ratePerSecond: opts.ratePerSecond ?? 1 });
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#onResult = opts.onResult;
    this.#beforeCall = opts.beforeCall;
  }

  async #get<S extends z.ZodType>(
    path: string,
    params: Record<string, string>,
    schema: S,
  ): Promise<SteamResult<z.infer<S>>> {
    const res = await this.#getInner(path, params, schema);
    if (this.#onResult) {
      const endpoint = path.split("/").filter(Boolean).slice(0, 2).join("/");
      const outcome = res.kind === "error" ? `error_${res.status ?? "network"}` : res.kind;
      this.#onResult(endpoint, outcome);
    }
    return res;
  }

  async #getInner<S extends z.ZodType>(
    path: string,
    params: Record<string, string>,
    schema: S,
  ): Promise<SteamResult<z.infer<S>>> {
    // Global cross-process budget gate first, then the local per-process cap.
    if (this.#beforeCall) {
      const endpoint = path.split("/").filter(Boolean).slice(0, 2).join("/");
      await this.#beforeCall(endpoint);
    }
    await this.#bucket.take();
    const search = new URLSearchParams({ key: this.#key, ...params });
    let res: Response;
    try {
      res = await this.#fetch(`${BASE}${path}?${search}`);
    } catch (err) {
      return { kind: "error", status: undefined, message: String(err) };
    }

    // Steam signals privacy with endpoint-specific 4xx codes. 5xx (incl. 503,
    // which GetPlayerItems alone reuses for private backpacks) stays transient
    // here so outages never masquerade as privacy — see getPlayerItems.
    if ([400, 401, 403].includes(res.status)) return { kind: "private" };
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", status: res.status, message: res.statusText };

    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      return { kind: "error", status: res.status, message: parsed.error.message };
    return { kind: "ok", data: parsed.data };
  }

  /** Batched up to 100 steamids per call. */
  async getPlayerSummaries(steamids: readonly string[]): Promise<SteamResult<PlayerSummary[]>> {
    if (steamids.length > 100) throw new RangeError("max 100 steamids");
    const res = await this.#get(
      "/ISteamUser/GetPlayerSummaries/v2/",
      { steamids: steamids.join(",") },
      getPlayerSummariesResponse,
    );
    return res.kind === "ok" ? { kind: "ok", data: res.data.response.players } : res;
  }

  /** TF2 playtime: exact total + last-2-weeks minutes (no derived flags). */
  async getTf2Playtime(
    steamid: string,
  ): Promise<SteamResult<{ minutes: number; minutes2wk: number }>> {
    const res = await this.#get(
      "/IPlayerService/GetOwnedGames/v1/",
      { steamid, include_played_free_games: "true", "appids_filter[0]": "440" },
      getOwnedGamesResponse,
    );
    if (res.kind !== "ok") return res;
    const tf2 = res.data.response.games?.find((g) => g.appid === 440);
    if (!tf2) return { kind: "empty" };
    return {
      kind: "ok",
      data: {
        minutes: tf2.playtime_forever,
        minutes2wk: tf2.playtime_2weeks ?? 0,
      },
    };
  }

  async getPlayerItems(steamid: string): Promise<SteamResult<BackpackItem[]>> {
    // This endpoint answers private backpacks with a bare 503 (verified
    // 2026-08-16) — but the TF2 GC behind it also 503s transiently under
    // load (backpack.tf measures ~40% failure in busy periods), so only a
    // 503 that persists across spaced retries counts as private.
    let res: SteamResult<z.infer<typeof getPlayerItemsResponse>> = {
      kind: "error",
      status: undefined,
      message: "unreached",
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000 * attempt));
      res = await this.#get(
        "/IEconItems_440/GetPlayerItems/v1/",
        { steamid },
        getPlayerItemsResponse,
      );
      if (!(res.kind === "error" && res.status === 503)) break;
    }
    if (res.kind === "error" && res.status === 503) return { kind: "private" };
    if (res.kind !== "ok") return res;
    const { status, items } = res.data.result;
    if (status === 15) return { kind: "private" };
    if (status === 18 || status === 8) return { kind: "not_found" };
    if (status !== 1 || !items) return { kind: "empty" };
    return { kind: "ok", data: items };
  }

  /** Raw TF2 stats as a name→value map. Empty stats ⇒ private game details. */
  async getUserStats(steamid: string): Promise<SteamResult<ReadonlyMap<string, number>>> {
    const res = await this.#get(
      "/ISteamUserStats/GetUserStatsForGame/v2/",
      { appid: "440", steamid },
      getUserStatsResponse,
    );
    if (res.kind !== "ok") return res;
    const stats = res.data.playerstats.stats;
    if (!stats || stats.length === 0) return { kind: "empty" };
    return { kind: "ok", data: new Map(stats.map((s) => [s.name, s.value])) };
  }

  /** Full friend edges (steamid + friend_since) — callers keep the graph. */
  async getFriendList(steamid: string): Promise<SteamResult<Friend[]>> {
    const res = await this.#get(
      "/ISteamUser/GetFriendList/v1/",
      { steamid, relationship: "friend" },
      getFriendListResponse,
    );
    return res.kind === "ok" ? { kind: "ok", data: res.data.friendslist.friends } : res;
  }

  async getPlayerBans(
    steamids: readonly string[],
  ): Promise<SteamResult<z.infer<typeof getPlayerBansResponse>["players"]>> {
    if (steamids.length > 100) throw new RangeError("max 100 steamids");
    const res = await this.#get(
      "/ISteamUser/GetPlayerBans/v1/",
      { steamids: steamids.join(",") },
      getPlayerBansResponse,
    );
    return res.kind === "ok" ? { kind: "ok", data: res.data.players } : res;
  }

  /** vanity URL name → steamid64 (null if no match) */
  async resolveVanityUrl(vanity: string): Promise<SteamResult<string | null>> {
    const res = await this.#get(
      "/ISteamUser/ResolveVanityURL/v1/",
      { vanityurl: vanity },
      resolveVanityResponse,
    );
    if (res.kind !== "ok") return res;
    return { kind: "ok", data: res.data.response.steamid ?? null };
  }

  /** Live concurrent players for TF2 (appid 440) — the whole game's CCU. */
  async getCurrentPlayers(): Promise<SteamResult<number>> {
    const res = await this.#get(
      "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
      { appid: "440" },
      getNumberOfCurrentPlayersResponse,
    );
    return res.kind === "ok" ? { kind: "ok", data: res.data.response.player_count } : res;
  }

  /** Master server list. `filter` uses Valve's \key\value syntax. */
  async getServerList(filter: string, limit = 50000): Promise<SteamResult<GameServer[]>> {
    const res = await this.#get(
      "/IGameServersService/GetServerList/v1/",
      { filter, limit: String(limit) },
      getServerListResponse,
    );
    return res.kind === "ok" ? { kind: "ok", data: res.data.response.servers ?? [] } : res;
  }

  /**
   * A2S proxy for SDR-hidden Valve MM servers (verified 2026-08-16).
   * `addr` is the fake addr from GetServerList, e.g. "169.254.143.172:63096".
   */
  async queryFakeIpPlayers(addr: string): Promise<SteamResult<FakeIpPlayer[]>> {
    const res = await this.#get(
      "/IGameServersService/QueryByFakeIP/v1/",
      { ...fakeAddrParams(addr), app_id: "440", query_type: "2" },
      queryByFakeIpPlayersResponse,
    );
    if (res.kind !== "ok") return res;
    const players = res.data.response.players_data?.players;
    return players ? { kind: "ok", data: players } : { kind: "empty" };
  }

  async queryFakeIpRules(addr: string): Promise<SteamResult<ReadonlyMap<string, string>>> {
    const res = await this.#get(
      "/IGameServersService/QueryByFakeIP/v1/",
      { ...fakeAddrParams(addr), app_id: "440", query_type: "3" },
      queryByFakeIpRulesResponse,
    );
    if (res.kind !== "ok") return res;
    const rules = res.data.response.rules_data?.rules;
    return rules
      ? { kind: "ok", data: new Map(rules.map((r) => [r.rule, r.value])) }
      : { kind: "empty" };
  }
}

/** QueryByFakeIP wants the IP packed as a uint32. */
function fakeAddrParams(addr: string): { fake_ip: string; fake_port: string } {
  const [ip, port] = addr.split(":");
  if (!ip || !port) throw new RangeError(`bad addr: ${addr}`);
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new RangeError(`bad ipv4: ${ip}`);
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  const packed = (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d);
  return { fake_ip: packed.toString(), fake_port: port };
}

import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Outcome of an API fetch for one endpoint. Recorded per player so privacy
 * rates (the old "is GetPlayerItems feasible" question) are measurable.
 */
export const fetchStatus = pgEnum("fetch_status", ["ok", "private", "not_found", "empty", "error"]);

export const frontierSource = pgEnum("frontier_source", [
  "seed",
  "friend_bfs",
  "review_sample",
  "random_sample",
  "recrawl",
]);

/** TF2 class numbers as used by the Web API (1=Scout ... 9=Engineer). */
export const players = pgTable(
  "players",
  {
    steamid: text().primaryKey(),
    firstSeen: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** how this player entered the corpus — kept forever for bias analysis */
    source: frontierSource(),
    lastCrawled: timestamp({ withTimezone: true }),
    personaname: text(),
    avatarHash: text(),
    /** ISO 3166-1 alpha-2 country from the Steam profile (loccountrycode);
     * nullable — only set for public profiles that expose a country, backfills
     * as the crawler recrawls. Coarse region hint for name→profile matching. */
    loccountrycode: text(),
    /** communityvisibilitystate: 3 = public */
    visibility: smallint(),
    tf2Minutes: integer(),
    /** exact playtime_2weeks minutes — "active" is derived, never stored */
    tf2Minutes2wk: integer("tf2_minutes_2wk"),
    vacBanned: boolean(),
    gameBans: smallint(),
    /** [0,1] likelihood this account is a bot / stat-outlier (idle, impossible
     * rates, hack markers, absurd playtime). Computed by the analyser every pass.
     * NULL = not yet scored (treated as 0 / included) — see docs/botness-signals.md.
     * >= 0.5 is excluded from usage aggregates and leaderboards. */
    botness: real(),
    itemsStatus: fetchStatus(),
    statsStatus: fetchStatus(),
    friendsStatus: fetchStatus(),
  },
  (t) => [index("players_last_crawled_idx").on(t.lastCrawled)],
);

/** Latest raw GetPlayerItems payload per player (replaced on recrawl). */
export const playerItemsRaw = pgTable("player_items_raw", {
  steamid: text()
    .primaryKey()
    .references(() => players.steamid),
  fetchedAt: timestamp({ withTimezone: true }).notNull(),
  payload: jsonb().notNull(),
});

/** Latest raw GetUserStatsForGame payload per player (replaced on recrawl). */
export const playerStatsRaw = pgTable("player_stats_raw", {
  steamid: text()
    .primaryKey()
    .references(() => players.steamid),
  fetchedAt: timestamp({ withTimezone: true }).notNull(),
  payload: jsonb().notNull(),
});

/**
 * Append-only stat snapshots — the raw material for delta attribution
 * (recrawl diffs = session-window observations). Never overwritten.
 */
export const playerStatSnapshots = pgTable(
  "player_stat_snapshots",
  {
    steamid: text().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    /** full GetUserStatsForGame name→value map */
    payload: jsonb().notNull(),
    /** parsed equipped loadout at the same instant ([[defindex,class,slot],...]) */
    loadout: jsonb(),
    tf2Minutes: integer(),
  },
  (t) => [primaryKey({ columns: [t.steamid, t.fetchedAt] })],
);

/** Latest raw friend list ([{steamid, friend_since}]) — the social graph. */
export const playerFriendsRaw = pgTable("player_friends_raw", {
  steamid: text()
    .primaryKey()
    .references(() => players.steamid),
  fetchedAt: timestamp({ withTimezone: true }).notNull(),
  payload: jsonb().notNull(),
});

/**
 * Parsed equipped loadout, stock weapons backfilled.
 * slot: 0-6 = weapon slots, 7 = cosmetic, 8 = taunt.
 */
export const equippedItems = pgTable(
  "equipped_items",
  {
    steamid: text()
      .notNull()
      .references(() => players.steamid),
    defindex: integer().notNull(),
    classNum: smallint().notNull(),
    slot: smallint().notNull(),
    /** item quality (6 = Unique; stock backfill rows are always 6) */
    quality: smallint().notNull().default(6),
    /** Strange kill_eater (attr 214) count; 0 if not Strange / not captured */
    strangeKills: integer("strange_kills").notNull().default(0),
    /** owner applied a Name Tag (custom_name present); false for pre-0013 rows */
    renamed: boolean("renamed").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.steamid, t.classNum, t.slot, t.defindex] }),
    index("equipped_items_defindex_idx").on(t.defindex),
  ],
);

/** Parsed <Class>.accum.* stats. classNum uses Web API numbering. */
export const playerClassStats = pgTable(
  "player_class_stats",
  {
    steamid: text()
      .notNull()
      .references(() => players.steamid),
    classNum: smallint().notNull(),
    playtimeSeconds: bigint({ mode: "number" }).notNull().default(0),
    kills: integer().notNull().default(0),
    killAssists: integer().notNull().default(0),
    damageDealt: bigint({ mode: "number" }).notNull().default(0),
    pointsScored: integer().notNull().default(0),
    dominations: integer().notNull().default(0),
    captures: integer().notNull().default(0),
    defenses: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.steamid, t.classNum] })],
);

/** TF2 item schema, synced from SteamDatabase/GameTracking-TF2. */
export const itemSchema = pgTable("item_schema", {
  defindex: integer().primaryKey(),
  name: text().notNull(),
  itemName: text(),
  imageUrl: text(),
  slot: text(),
  usedByClasses: smallint().array().notNull(),
  equipRegions: text().array(),
  /** Groups reskins (e.g. all stock-scattergun reskins) for merged stats. */
  reskinGroup: integer(),
});

/**
 * Which classes can equip an item in which slot (0=primary/1=secondary/2=melee,
 * from items_game used_by_classes slot overrides). Powers correct class=Any
 * per-slot denominators for slot-varying items (shotgun, Panic Attack).
 */
export const itemClassSlots = pgTable(
  "item_class_slots",
  {
    defindex: integer().notNull(),
    classNum: smallint().notNull(),
    slot: smallint().notNull(),
  },
  (t) => [primaryKey({ columns: [t.defindex, t.classNum, t.slot] })],
);

/**
 * Cross-process Steam API budget broker (see steamBudget.ts + the
 * steam_budget_take() SQL function). One row per rate CLASS plus a special
 * '_shared' surplus row, modelling a hierarchical token bucket: the sum of all
 * class floors + the shared refill is the GLOBAL rate ceiling for the single
 * API key. A call from a class is admitted if that class's own bucket has a
 * token (its guaranteed floor / starvation protection) OR the shared bucket
 * does (borrowed surplus / fairness). Every crawler/scanner/sampler/web call
 * passes through this, so the combined rate can never exceed Steam's ~100k/day.
 * Tunable at runtime by UPDATEing refill_per_sec / capacity — no redeploy.
 * NOTE: web_ro needs EXECUTE on steam_budget_take(text) (deployer handles it);
 * the function is SECURITY DEFINER so web_ro stays read-only on the table.
 */
export const steamBudget = pgTable("steam_budget", {
  /** rate class: 'crawler' | 'scanner' | 'sampler' | 'web' | '_shared' */
  class: text().primaryKey(),
  /** current tokens (fractional); a token = one permitted API call */
  tokens: doublePrecision().notNull(),
  /** burst ceiling — max tokens this bucket can bank */
  capacity: doublePrecision().notNull(),
  /** steady refill rate in tokens/second (a class's guaranteed floor) */
  refillPerSec: doublePrecision("refill_per_sec").notNull(),
  /** last refill wall-clock, advanced atomically inside steam_budget_take() */
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** lifetime admitted-call counter, for observability */
  consumedTotal: bigint("consumed_total", { mode: "number" }).notNull().default(0),
});

/** hourly Steam API call outcome counters, for the /health page */
export const apiMetrics = pgTable(
  "api_metrics",
  {
    hour: timestamp({ withTimezone: true }).notNull(),
    endpoint: text().notNull(),
    outcome: text().notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.hour, t.endpoint, t.outcome] })],
);

/** avg performance of players equipping a weapon (merged group id) per class */
export const weaponClassStats = pgTable(
  "weapon_class_stats",
  {
    defindex: integer().notNull(),
    classNum: smallint().notNull(),
    players: integer().notNull(),
    avgPointsPerMin: real().notNull(),
    avgKillsPerHour: real().notNull(),
    avgDamagePerMin: real().notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.defindex, t.classNum] })],
);

/**
 * Precomputed top-100 per leaderboard board (see boards.ts for the key grid),
 * rewritten by the analyser every 15 minutes.
 * NOTE: web_ro needs SELECT on leaderboard_entries (deployer handles grants).
 */
export const leaderboardEntries = pgTable(
  "leaderboard_entries",
  {
    boardKey: text().notNull(),
    rank: integer().notNull(),
    steamid: text().notNull(),
    value: real().notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardKey, t.rank] })],
);

/**
 * Per-board participant counts (percentile denominators), rewritten alongside
 * leaderboard_entries by the analyser.
 * NOTE: web_ro needs SELECT on leaderboard_meta (deployer handles grants).
 */
export const leaderboardMeta = pgTable("leaderboard_meta", {
  boardKey: text().primaryKey(),
  participants: integer().notNull(),
});

export const crawlFrontier = pgTable(
  "crawl_frontier",
  {
    steamid: text().primaryKey(),
    source: frontierSource().notNull(),
    priority: smallint().notNull().default(0),
    enqueuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: smallint().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [index("crawl_frontier_dequeue_idx").on(t.priority, t.enqueuedAt)],
);

/** One row per (scan, map, region, official-or-not) — aggregated, not per-server.
 * Only servers with human players are recorded here (empty community servers go
 * in server_empty_snapshots; empty Valve servers are unmeasurable — the master
 * list truncates at 10k phantom matchmaking reservations). `capacity` is the sum
 * of max_players across the bucket's servers, so seat-fill = players / capacity.
 * The *_servers columns count how many of the bucket's servers carry each
 * gametype tag (parsed from sv_tags); all default 0 so historical rows are
 * unaffected. */
export const serverSnapshots = pgTable(
  "server_snapshots",
  {
    scannedAt: timestamp({ withTimezone: true }).notNull(),
    map: text().notNull(),
    /** Valve region code from GetServerList (255 = unknown/SDR) */
    region: smallint().notNull(),
    official: boolean().notNull(),
    serverCount: integer().notNull(),
    players: integer().notNull(),
    bots: integer().notNull(),
    /** sum of max_players across the bucket's servers (seat capacity) */
    capacity: integer().notNull().default(0),
    /** count of servers in the bucket carrying each sv_tags flag */
    alltalkServers: integer().notNull().default(0),
    nocritsServers: integer().notNull().default(0),
    respawntimesServers: integer().notNull().default(0),
    maxplayersServers: integer().notNull().default(0),
    highlanderServers: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.scannedAt, t.map, t.region, t.official] }),
    index("server_snapshots_scanned_at_idx").on(t.scannedAt),
  ],
);

/** Empty community servers per (scan, region), kept coarse (no map dimension) to
 * avoid the per-map row explosion of thousands of idle community maps. Lets us
 * report the empty-vs-populated ratio for community servers. Valve empties are
 * deliberately excluded (master-list truncation makes their count meaningless). */
export const serverEmptySnapshots = pgTable(
  "server_empty_snapshots",
  {
    scannedAt: timestamp({ withTimezone: true }).notNull(),
    region: smallint().notNull(),
    servers: integer().notNull(),
    capacity: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scannedAt, t.region] }),
    index("server_empty_snapshots_scanned_at_idx").on(t.scannedAt),
  ],
);

/** TF2's live global concurrent-player count (Steam GetNumberOfCurrentPlayers),
 * sampled once per scan. The hard ground-truth denominator for "how much of the
 * playerbase do we cover" — independent of our crawl. Written by scanner.ts. */
export const populationSnapshots = pgTable("population_snapshots", {
  scannedAt: timestamp({ withTimezone: true }).primaryKey(),
  currentPlayers: integer().notNull(),
});

/**
 * One continuous run of sampler observations of a single Valve casual server
 * (identified by its GetServerList steamid) on one map. A map change or the
 * end of a sampling cycle closes the segment. Written by
 * apps/crawler/src/sampler.ts.
 */
export const matchSegments = pgTable(
  "match_segments",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    serverSteamid: text().notNull(),
    map: text().notNull(),
    /** Valve region code from GetServerList (255 = unknown/SDR) */
    region: smallint().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }).notNull(),
    /** number of successful player-query rounds folded into this segment */
    observations: smallint().notNull(),
    /** why the segment stopped, set when the sampler closes it:
     * 'score_reset' (scoreboard reset = new match on the same server) and
     * 'map_change' are true match boundaries → segment span is a real match
     * length. 'server_gone' (server emptied/vanished) is ambiguous/truncated.
     * NULL = still open or closed by process restart. */
    reasonClosed: text("reason_closed"),
  },
  (t) => [index("match_segments_started_at_idx").on(t.startedAt)],
);

/**
 * Per-player-name score trajectory endpoints within a match segment. Only raw
 * endpoints are stored — observed points/hour is derived at query time as
 * (last_score - first_score) / (last_seen - first_seen).
 *
 * `name` is the raw in-game name (unicode preserved, trimmed to 64 chars); it
 * later joins probabilistically to players.personaname + stat-delta windows —
 * that fusion is intentionally NOT done here.
 */
export const matchParticipants = pgTable(
  "match_participants",
  {
    segmentId: bigint({ mode: "number" })
      .notNull()
      .references(() => matchSegments.id),
    name: text().notNull(),
    firstSeen: timestamp({ withTimezone: true }).notNull(),
    lastSeen: timestamp({ withTimezone: true }).notNull(),
    firstScore: integer().notNull(),
    lastScore: integer().notNull(),
    maxScore: integer().notNull(),
    firstTimePlayed: real().notNull(),
    lastTimePlayed: real().notNull(),
    observations: smallint().notNull(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.name] })],
);

/**
 * Precomputed usage aggregates served by the site (the styletf model).
 * classNum/slot -1 = "any"; minutesThreshold 0 = "any"; activeMinutes2wk 0 = "any".
 */
export const usageStats = pgTable(
  "usage_stats",
  {
    defindex: integer().notNull(),
    classNum: smallint().notNull(),
    slot: smallint().notNull(),
    /** min minutes played in the last 2 weeks (bucket: 0/1/300/900) */
    activeMinutes2wk: smallint("active_minutes_2wk").notNull(),
    /** min lifetime minutes (bucket: 0/30000/60000/120000/240000) */
    minutesThreshold: integer().notNull(),
    mergeReskins: boolean().notNull(),
    usage: real().notNull(),
    /** raw equip count (un-normalized, unlike usage for class=Any rows) */
    count: integer().notNull().default(0),
    sampleSize: integer().notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_stats_key_idx").on(
      t.defindex,
      t.classNum,
      t.slot,
      t.activeMinutes2wk,
      t.minutesThreshold,
      t.mergeReskins,
    ),
    index("usage_stats_filter_idx").on(
      t.classNum,
      t.slot,
      t.activeMinutes2wk,
      t.minutesThreshold,
      t.mergeReskins,
    ),
  ],
);

/**
 * Daily headline-usage history for the /usage delta-compare feature. Only the
 * default view is retained (classNum/slot = -1 "any", default population,
 * merged reskins) so this stays bounded to ~one row per item per day rather
 * than mirroring the full usage_stats cube. The analyser upserts today's row
 * every run, so `day` holds that day's latest headline value. No backfill —
 * history accrues from first deploy forward.
 */
export const usageStatsHistory = pgTable(
  "usage_stats_history",
  {
    defindex: integer().notNull(),
    /** UTC calendar day of the snapshot */
    day: date().notNull(),
    /** normalized usage share for the default headline view */
    usage: real().notNull(),
    /** raw equip count for the default headline view */
    count: integer().notNull().default(0),
    /** population size the headline view was computed over */
    sampleSize: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.defindex, t.day] })],
);

/**
 * Forward attribution: a sampled participant NAME (match_participants) resolved
 * to a real steamid at high confidence, using the SAME evidence-weighted scoring
 * as the on-demand resolver in apps/web/src/server/matches.ts — name similarity
 * (0.45) + exact-match uniqueness + recent activity + stat-delta corroboration,
 * clamped to [0,1]. Only rows with confidence >= 0.9 are written, so a row here
 * is an ASSERTED identity, not a candidate list. One row per participant.
 * Written by apps/crawler/src/attributor.ts every pass.
 * NOTE: web_ro needs SELECT (deployer handles grants).
 */
export const segmentAttributions = pgTable(
  "segment_attributions",
  {
    segmentId: bigint({ mode: "number" })
      .notNull()
      .references(() => matchSegments.id),
    /** the raw in-game name from match_participants this attribution is for */
    name: text().notNull(),
    steamid: text()
      .notNull()
      .references(() => players.steamid),
    /** combined confidence, 0..1 (only >= 0.9 stored) */
    confidence: real().notNull(),
    /** trigram name similarity component, 0..1 */
    similarity: real().notNull(),
    exactName: boolean("exact_name").notNull(),
    recentlyActive: boolean("recently_active").notNull(),
    /** playtime provably accrued across a snapshot pair spanning the segment */
    deltaCorroborated: boolean("delta_corroborated").notNull(),
    /** deltaCorroborated && confidence >= 0.7 (the resolver's "strong" tier) */
    strong: boolean().notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.name] }),
    index("segment_attributions_steamid_idx").on(t.steamid),
  ],
);

/**
 * A delta window between two consecutive stat snapshots of one player — the unit
 * of session-level attribution. Flags describe whether the window is usable and
 * what it isolates:
 *  - reset: a per-class lifetime playtime went BACKWARDS (stats reset / decode
 *    glitch) → deltas are garbage, excluded from attribution.
 *  - upload_lag: no class playtime moved at all (GetUserStatsForGame only flushes
 *    on disconnect, so mid-session snapshots read flat) → no signal to attribute.
 *  - pure_map: over the window the player's attributed sampler segments (see
 *    segment_attributions) covered exactly ONE map → the whole class-playtime
 *    delta is attributable to that map.
 *  - pure_class: exactly one class's playtime advanced in the window.
 * classDeltas holds per-class playtime SECONDS gained ({ "<classNum>": seconds }),
 * positive deltas only. statDeltas holds the other accum stats gained per moved
 * class, and loadout/loadoutStable let window_perf attribute those gains to the
 * weapons equipped through the window. Written/upserted by
 * apps/crawler/src/attributor.ts.
 */
export const statWindows = pgTable(
  "stat_windows",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    steamid: text()
      .notNull()
      .references(() => players.steamid),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    endedAt: timestamp({ withTimezone: true }).notNull(),
    /** total class playtime seconds gained across the window (sum of positive deltas) */
    playtimeDeltaSec: integer("playtime_delta_sec").notNull().default(0),
    reset: boolean().notNull().default(false),
    uploadLag: boolean("upload_lag").notNull().default(false),
    pureMap: boolean("pure_map").notNull().default(false),
    pureClass: boolean("pure_class").notNull().default(false),
    /** the single map when pure_map, else null */
    map: text(),
    /** per-class playtime seconds gained, { "<classNum>": seconds } (positive only) */
    classDeltas: jsonb("class_deltas").notNull(),
    /** per moved class, positive-only accum-stat gains (playtime lives in
     * class_deltas), same reset guard: { "<classNum>": { kills, assists, damage,
     * points, dominations, captures, defenses } } */
    statDeltas: jsonb("stat_deltas").notNull().default({}),
    /** the END snapshot's equipped loadout triples ([[defindex,class,slot],...]);
     * null when either endpoint snapshot had no loadout captured */
    loadout: jsonb(),
    /** for every moved class the slot<=6 weapon triples were identical at both
     * endpoints, so the window's stat gains map to a stable weapon set */
    loadoutStable: boolean("loadout_stable").notNull().default(false),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stat_windows_key_idx").on(t.steamid, t.startedAt, t.endedAt),
    index("stat_windows_ended_at_idx").on(t.endedAt),
  ],
);

/**
 * Class playtime attributed to a map: the per-class playtime delta summed over
 * PURE-MAP, non-reset stat windows (see stat_windows). Answers "how much
 * <class> time happens on map <map>". Rebuilt (delete+insert) every pass by
 * apps/crawler/src/attributor.ts.
 * NOTE: web_ro needs SELECT (deployer handles grants).
 */
export const mapClassPlaytime = pgTable(
  "map_class_playtime",
  {
    map: text().notNull(),
    classNum: smallint().notNull(),
    playtimeSeconds: bigint("playtime_seconds", { mode: "number" }).notNull().default(0),
    /** number of contributing pure-map windows */
    windows: integer().notNull().default(0),
    /** distinct attributed players contributing */
    players: integer().notNull().default(0),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.map, t.classNum] })],
);

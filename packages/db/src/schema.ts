import {
  bigint,
  boolean,
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
    /** communityvisibilitystate: 3 = public */
    visibility: smallint(),
    tf2Minutes: integer(),
    /** exact playtime_2weeks minutes — "active" is derived, never stored */
    tf2Minutes2wk: integer("tf2_minutes_2wk"),
    vacBanned: boolean(),
    gameBans: smallint(),
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

/** One row per (scan, map, region, official-or-not) — aggregated, not per-server. */
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
  },
  (t) => [
    primaryKey({ columns: [t.scannedAt, t.map, t.region, t.official] }),
    index("server_snapshots_scanned_at_idx").on(t.scannedAt),
  ],
);

/**
 * Precomputed usage aggregates served by the site (the styletf model).
 * classNum/slot -1 = "any"; minutesThreshold 0 = "any"; activeOnly false = "any".
 */
export const usageStats = pgTable(
  "usage_stats",
  {
    defindex: integer().notNull(),
    classNum: smallint().notNull(),
    slot: smallint().notNull(),
    activeOnly: boolean().notNull(),
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
      t.activeOnly,
      t.minutesThreshold,
      t.mergeReskins,
    ),
    index("usage_stats_filter_idx").on(
      t.classNum,
      t.slot,
      t.activeOnly,
      t.minutesThreshold,
      t.mergeReskins,
    ),
  ],
);

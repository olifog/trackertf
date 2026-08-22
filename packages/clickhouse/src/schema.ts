import type { ClickHouseClient } from "@clickhouse/client";

/**
 * ClickHouse analytics tables. These are DERIVED, rebuilt from Postgres (the
 * source of truth) by the syncer via staging-table + atomic EXCHANGE TABLES.
 * All MergeTree — no versioning needed because each sync fully replaces the
 * table contents.
 *
 * Experience columns (`lifetime_min` = tf2 minutes ever, `active_2wk_min` =
 * minutes in the last 2 weeks) are denormalized onto every fact row so usage,
 * combo, delta and performance queries can filter by ARBITRARY thresholds at
 * query time — no precomputed population buckets.
 */
export const CH_SCHEMA: Record<string, string> = {
  // one row per equipped item (weapons slots 0-6 + cosmetics slot 7)
  equipped: `(
    steamid UInt64,
    class_num UInt8,
    slot Int8,
    defindex UInt32,
    gid UInt32,
    cgid UInt32,
    quality UInt8,
    strange_kills UInt32,
    renamed UInt8,
    lifetime_min UInt32,
    active_2wk_min UInt32
  ) ENGINE = MergeTree ORDER BY (class_num, slot, cgid, steamid)`,

  // one row per (player, class) with the sorted-distinct set of weapon groups
  // they run — powers 2/3/N-weapon combo aggregation via array joins
  loadout: `(
    steamid UInt64,
    class_num UInt8,
    weapon_gids Array(UInt32),
    all_gids Array(UInt32),
    lifetime_min UInt32,
    active_2wk_min UInt32
  ) ENGINE = MergeTree ORDER BY (class_num, steamid)`,

  // per-class lifetime accum stats — for item/combo performance (pts/hr of
  // equippers) and player performance boards
  player_class: `(
    steamid UInt64,
    class_num UInt8,
    playtime_seconds UInt64,
    kills UInt64,
    kill_assists UInt64,
    damage_dealt UInt64,
    points_scored UInt64,
    dominations UInt64,
    captures UInt64,
    defenses UInt64,
    lifetime_min UInt32,
    active_2wk_min UInt32
  ) ENGINE = MergeTree ORDER BY (class_num, steamid)`,

  // one row per (stat window, moved class): the accum stats a player gained
  // while equipping a stable weapon set, for forward "session" performance.
  // weapon_gids folds the class's slot<=6 loadout into cgids like `loadout`.
  window_perf: `(
    steamid UInt64,
    class_num UInt8,
    ended_at DateTime,
    playtime_sec UInt32,
    kills UInt32,
    assists UInt32,
    damage UInt64,
    points UInt32,
    dominations UInt32,
    captures UInt32,
    defenses UInt32,
    weapon_gids Array(UInt32),
    loadout_stable UInt8,
    pure_class UInt8,
    pure_map UInt8,
    map String,
    lifetime_min UInt32,
    active_2wk_min UInt32
  ) ENGINE = MergeTree ORDER BY (class_num, ended_at, steamid)`,

  // sampler-observed per-player score trajectories inside casual match segments
  match_obs: `(
    segment_id UInt64,
    server_steamid UInt64,
    map String,
    region Int8,
    started_at DateTime,
    name String,
    first_seen DateTime,
    last_seen DateTime,
    first_score Int32,
    last_score Int32,
    max_score Int32,
    first_time_played Float32,
    last_time_played Float32,
    observations UInt16,
    -- segment_id point-lookups (fetchSegment, resolveParticipant) don't hit the
    -- (started_at, ...) sort-key prefix, so they full-scan this ever-growing
    -- table. segment_id is a monotonic bigserial strongly correlated with
    -- started_at, so a minmax skip index prunes granules cheaply.
    INDEX idx_segment_id segment_id TYPE minmax GRANULARITY 1
  ) ENGINE = MergeTree ORDER BY (started_at, segment_id, name)`,
};

/** Create every analytics table if absent. Idempotent. */
export async function applySchema(ch: ClickHouseClient): Promise<void> {
  for (const [name, def] of Object.entries(CH_SCHEMA)) {
    await ch.command({ query: `CREATE TABLE IF NOT EXISTS ${name} ${def}` });
  }
}

/**
 * PG -> ClickHouse ETL. Every INTERVAL, rebuilds the analytics tables (equipped,
 * loadout, player_class, match_obs) from Postgres into staging tables, then
 * atomically EXCHANGEs them into place. Postgres stays the source of truth;
 * ClickHouse serves the heavy analytical reads (usage, combos, deltas,
 * performance) with arbitrary experience thresholds at query time.
 */
import { applySchema, type Ch, createChFromEnv } from "@trackertf/clickhouse";
import { CH_SCHEMA } from "@trackertf/clickhouse/schema";
import { createDbFromEnv } from "@trackertf/db";
import { sql } from "drizzle-orm";

const db = createDbFromEnv();
const ch = createChFromEnv();
const INTERVAL_MS = 15 * 60_000;
const INSERT_CHUNK = 100_000;

/** class-aware pan-family remap → each class's stock melee (mirrors analyser) */
const PAN_REMAP = sql`case e.class_num
  when 1 then 0 when 4 then 1 when 7 then 2 when 2 then 3 when 8 then 4
  when 6 then 5 when 3 then 6 when 9 then 7 when 5 then 8
  else coalesce(s.reskin_group, e.defindex) end`;

/** gid = reskin group; cgid folds the all-class pan family into class melee */
const ENRICHED_EQUIPPED = sql`
  select e.steamid::text as steamid, e.class_num, e.slot, e.defindex,
         coalesce(s.reskin_group, e.defindex) as gid,
         case when coalesce(s.reskin_group, e.defindex)
                   = (select coalesce(reskin_group, 264) from item_schema where defindex = 264)
           then ${PAN_REMAP}
           else coalesce(s.reskin_group, e.defindex) end as cgid,
         e.quality, e.strange_kills,
         coalesce(p.tf2_minutes, 0) as lifetime_min,
         coalesce(p.tf2_minutes_2wk, 0) as active_2wk_min
  from equipped_items e
  join players p on p.steamid = e.steamid and p.items_status = 'ok'
    and coalesce(p.botness, 0) < 0.5
  left join item_schema s on s.defindex = e.defindex`;

async function swap(name: string, fill: (staging: string) => Promise<void>): Promise<void> {
  const staging = `${name}_staging`;
  const def = CH_SCHEMA[name];
  if (!def) throw new Error(`no CH schema for ${name}`);
  await ch.command({ query: `DROP TABLE IF EXISTS ${staging}` });
  await ch.command({ query: `CREATE TABLE ${staging} ${def}` });
  await fill(staging);
  await ch.command({ query: `EXCHANGE TABLES ${name} AND ${staging}` });
  await ch.command({ query: `DROP TABLE IF EXISTS ${staging}` });
}

async function insertRows(
  client: Ch,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await client.insert({ table, values: rows.slice(i, i + INSERT_CHUNK), format: "JSONEachRow" });
  }
}

async function syncEquipped(): Promise<void> {
  const rows = (await db.execute(ENRICHED_EQUIPPED)) as unknown as Record<string, unknown>[];
  const equipped = rows.map((r) => ({
    steamid: r["steamid"],
    class_num: r["class_num"],
    slot: r["slot"],
    defindex: r["defindex"],
    gid: r["gid"],
    cgid: r["cgid"],
    quality: r["quality"],
    strange_kills: r["strange_kills"],
    lifetime_min: r["lifetime_min"],
    active_2wk_min: r["active_2wk_min"],
  }));
  await swap("equipped", (staging) => insertRows(ch, staging, equipped));

  // fold flat rows into per-(player,class) loadout arrays for combo queries
  type L = { weapon: Set<number>; all: Set<number>; lifetime: number; active: number };
  const loadouts = new Map<string, L>();
  for (const r of rows) {
    const key = `${r["steamid"]}:${r["class_num"]}`;
    let l = loadouts.get(key);
    if (!l) {
      l = { weapon: new Set(), all: new Set(), lifetime: 0, active: 0 };
      l.lifetime = r["lifetime_min"] as number;
      l.active = r["active_2wk_min"] as number;
      loadouts.set(key, l);
    }
    const slot = r["slot"] as number;
    const cgid = r["cgid"] as number;
    if (slot <= 6) l.weapon.add(cgid);
    if (slot <= 7) l.all.add(cgid);
  }
  const loadoutRows = [...loadouts.entries()].map(([key, l]) => {
    const [steamid, classNum] = key.split(":");
    return {
      steamid,
      class_num: Number(classNum),
      weapon_gids: [...l.weapon].toSorted((a, b) => a - b),
      all_gids: [...l.all].toSorted((a, b) => a - b),
      lifetime_min: l.lifetime,
      active_2wk_min: l.active,
    };
  });
  await swap("loadout", (staging) => insertRows(ch, staging, loadoutRows));
}

async function syncPlayerClass(): Promise<void> {
  const rows = (await db.execute(sql`
    select c.steamid::text as steamid, c.class_num, c.playtime_seconds, c.kills,
           c.kill_assists, c.damage_dealt, c.points_scored, c.dominations,
           c.captures, c.defenses,
           coalesce(p.tf2_minutes, 0) as lifetime_min,
           coalesce(p.tf2_minutes_2wk, 0) as active_2wk_min
    from player_class_stats c
    join players p on p.steamid = c.steamid and p.stats_status = 'ok'
      and coalesce(p.botness, 0) < 0.5
  `)) as unknown as Record<string, unknown>[];
  await swap("player_class", (staging) => insertRows(ch, staging, rows));
}

async function syncMatchObs(): Promise<void> {
  const rows = (await db.execute(sql`
    select mp.segment_id::text as segment_id, ms.server_steamid::text as server_steamid,
           ms.map, ms.region, extract(epoch from ms.started_at)::bigint as started_at,
           mp.name,
           extract(epoch from mp.first_seen)::bigint as first_seen,
           extract(epoch from mp.last_seen)::bigint as last_seen,
           mp.first_score, mp.last_score, mp.max_score,
           mp.first_time_played, mp.last_time_played, mp.observations
    from match_participants mp
    join match_segments ms on ms.id = mp.segment_id
  `)) as unknown as Record<string, unknown>[];
  await swap("match_obs", (staging) => insertRows(ch, staging, rows));
}

async function syncAll(): Promise<void> {
  await syncEquipped();
  await syncPlayerClass();
  await syncMatchObs();
}

async function main(): Promise<void> {
  console.log("syncer started");
  await applySchema(ch);
  for (;;) {
    const start = Date.now();
    try {
      await syncAll();
      console.log(`clickhouse sync complete in ${Date.now() - start}ms`);
    } catch (err) {
      console.error("syncer run failed:", err);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}

await main();

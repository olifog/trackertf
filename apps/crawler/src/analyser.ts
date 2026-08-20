/**
 * Recomputes usage_stats from equipped_items for every filter combination:
 * 20 populations (total-hours × 2-week-activity buckets) × all class/slot
 * rollups × merge modes. Replaces styletf's 400-combo Mongo cartesian product
 * with one SQL pass per population.
 */
import { createDbFromEnv } from "@trackertf/db";
import { BOARDS, boardCountSql, boardSelectSql } from "@trackertf/db/boards";
import { sql } from "drizzle-orm";

const db = createDbFromEnv();
const INTERVAL_MS = 15 * 60_000;

/** min lifetime minutes: everyone / 500h / 1000h / 2000h / 4000h */
const HOURS_BUCKETS = [0, 30_000, 60_000, 120_000, 240_000] as const;
/** min minutes played in the last 2 weeks: everyone / played / 5h / 15h */
const ACTIVE_2WK_BUCKETS = [0, 1, 300, 900] as const;

const POPULATIONS = HOURS_BUCKETS.flatMap((minutes) =>
  ACTIVE_2WK_BUCKETS.map((active2wk) => ({ minutes, active2wk })),
);

/**
 * Per-player "botness" float in [0,1] written to players.botness, recomputed
 * every pass from player_class_stats (rates, playtime, hack markers) and
 * equipped_items (zero-effort loadout tell). Excludes junk accounts — idle
 * bots, stat-hackers, corrupted profiles — from usage aggregates and
 * leaderboards. Full derivation + measured thresholds in docs/botness-signals.md.
 *
 * Runs BEFORE recompute()/recomputeWeaponStats()/recomputeLeaderboards() so
 * those passes read this run's freshly-written scores (same-pass consistency).
 * Only players with class stats are scored; players without stay NULL = included
 * (absence of evidence is not a flag).
 *
 * Signals: (1) impossible per-class rates, (2) hack-marker saturation values,
 * (3) impossible playtime ceilings, (4) idle shape (points-based, so real
 * medics aren't flagged), (5) all-stock weapon loadout across engaged classes
 * (fraction of weapon slots left on the default item, gated on real per-class
 * playtime), (6) idle-engagement: high lifetime hours but little actual class
 * playtime (the classic idle-server / afk-farm tell). Hard flags (1/2/3 at their
 * impossible caps) force 1.0; the rest are graded sub-scores combined via a
 * weighted noisy-OR (w: rate .9, time .8, idle .9, stock .6, engage .6). Cutoff
 * for exclusion is botness >= 0.5 — a near-total stock loadout, or a low-effort
 * loadout paired with any idle signal, now clears it.
 */
async function recomputeBotness(): Promise<void> {
  await db.execute(sql`
    with class_agg as (
      select
        c.steamid,
        max(coalesce(pp.tf2_minutes, 0)) as lifetime_min,
        sum(c.playtime_seconds) as total_secs,
        max(c.playtime_seconds) as max_class_secs,
        -- hack-marker saturation: INT32 max (2^31-1) or the ~1e9 offset
        max(case when c.kills >= 1000000000 or c.kills = 2147483647
                   or c.points_scored >= 1000000000 or c.points_scored = 2147483647
                   or c.damage_dealt >= 1000000000 or c.damage_dealt = 2147483647
                   or c.kill_assists >= 1000000000 or c.kill_assists = 2147483647
              then 1 else 0 end) as hack,
        -- physically-impossible per-class rate (>= 1h denominator)
        max(case when c.playtime_seconds >= 3600 and (
                   c.kills::float8 * 3600 / c.playtime_seconds > 1500
                or c.damage_dealt::float8 * 60 / c.playtime_seconds > 3000
                or c.points_scored::float8 * 60 / c.playtime_seconds > 30)
              then 1 else 0 end) as rate_hard,
        -- graded rate suspicion: max over classes of the per-metric ramp from
        -- ~p99 up to the hard cap (kph 600->1500, dpm 700->3000, ppm 6->30)
        max(case when c.playtime_seconds >= 3600 then greatest(
                 least(greatest((c.kills::float8 * 3600 / c.playtime_seconds - 600) / 900, 0), 1),
                 least(greatest((c.damage_dealt::float8 * 60 / c.playtime_seconds - 700) / 2300, 0), 1),
                 least(greatest((c.points_scored::float8 * 60 / c.playtime_seconds - 6) / 24, 0), 1))
              else 0 end) as s_rate,
        -- idle shape: lowest points/hr among the player's 100h+ classes
        min(case when c.playtime_seconds >= 360000
              then c.points_scored::float8 * 3600 / c.playtime_seconds end) as min_pph_100h
      from player_class_stats c
      join players pp on pp.steamid = c.steamid
      group by c.steamid
    ),
    -- zero-effort loadout tell: fraction of WEAPON slots (primary/secondary/melee,
    -- slot 0/1/2) left on the stock item across classes the player has actually
    -- played (>=10h). Raw defindex, not gid — a reskin is still a deliberate
    -- choice. Stock weapon defindexes mirror parse.ts STOCK_ITEMS.
    stock_agg as (
      select e.steamid,
        count(distinct e.class_num) filter (where pcs.playtime_seconds >= 36000)::int as played_classes,
        count(*) filter (where pcs.playtime_seconds >= 36000)::int as weapon_slots,
        count(*) filter (where pcs.playtime_seconds >= 36000 and e.defindex in
          (0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,29,30))::int as stock_slots
      from equipped_items e
      join player_class_stats pcs on pcs.steamid = e.steamid and pcs.class_num = e.class_num
      where e.slot in (0, 1, 2)
      group by e.steamid
    )
    update players p set botness = sub.botness
    from (
      select ca.steamid,
        case
          when ca.hack = 1 or ca.rate_hard = 1
            or ca.total_secs > 30000 * 3600 or ca.max_class_secs > 30000 * 3600
          then 1.0
          else 1 - (
            (1 - 0.9 * coalesce(ca.s_rate, 0))
            * (1 - 0.8 * least(greatest((ca.total_secs / 3600.0 - 15000) / 15000, 0), 1))
            * (1 - 0.9 * case when ca.min_pph_100h is not null
                 then least(greatest((5 - ca.min_pph_100h) / 3.0, 0), 1) else 0 end)
            -- (5) near-total stock loadout across 2+ engaged classes with real
            -- investment (>=300h). Fraction of weapon slots on default items.
            * (1 - 0.6 * case when ca.total_secs >= 300 * 3600
                 and coalesce(sa.played_classes, 0) >= 2 and coalesce(sa.weapon_slots, 0) > 0
                 then sa.stock_slots::float8 / sa.weapon_slots else 0 end)
            -- (6) idle-engagement: at 2000h+ lifetime, ramp on how little of that
            -- time shows up as actual class playtime (ratio 0.4 -> 0, 0.1 -> 1)
            * (1 - 0.6 * case when ca.lifetime_min >= 120000 and ca.total_secs > 0
                 and ca.lifetime_min * 60 > ca.total_secs
                 then least(greatest(
                   (0.4 - ca.total_secs::float8 / (ca.lifetime_min * 60)) / 0.3, 0), 1)
                 else 0 end)
          )
        end as botness
      from class_agg ca
      left join stock_agg sa on sa.steamid = ca.steamid
    ) sub
    where p.steamid = sub.steamid
  `);
}

async function recompute(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from usage_stats`);
    for (const pop of POPULATIONS) {
      await tx.execute(sql`
        with pop as (
          select p.steamid from players p
          where p.items_status = 'ok'
            and coalesce(p.tf2_minutes_2wk, 0) >= ${pop.active2wk}
            and coalesce(p.tf2_minutes, 0) > ${pop.minutes}
            and coalesce(p.botness, 0) < 0.5
        ),
        total as (select count(*)::int n from pop),
        pan_group as (
          -- the all-class stock-stat melee family (Frying Pan et al.)
          select coalesce(reskin_group, 264) gid from item_schema where defindex = 264
        ),
        eq as (
          select e.steamid, e.class_num, e.slot, e.defindex as raw_defindex,
                 coalesce(s.reskin_group, e.defindex) as gid,
                 -- class-specific merge id: pan-family folds into the class's
                 -- stock melee (for a scout, a Pan IS a Bat). Any-class rollups
                 -- keep the family separate to avoid cross-class collapse.
                 case when coalesce(s.reskin_group, e.defindex) = (select gid from pan_group)
                   then case e.class_num
                     when 1 then 0 when 4 then 1 when 7 then 2 when 2 then 3 when 8 then 4
                     when 6 then 5 when 3 then 6 when 9 then 7 when 5 then 8
                     else coalesce(s.reskin_group, e.defindex) end
                   else coalesce(s.reskin_group, e.defindex) end as cgid
          from equipped_items e
          join pop using (steamid)
          left join item_schema s on s.defindex = e.defindex
        ),
        counts_raw as (
          select class_num, slot, raw_defindex d, count(*)::int c from eq group by 1, 2, 3
        ),
        counts_global as (select class_num, slot, gid d, count(*)::int c from eq group by 1, 2, 3),
        counts_class as (select class_num, slot, cgid d, count(*)::int c from eq group by 1, 2, 3),
        rollups as (
          select false merged, class_num, slot, d as defindex, c from counts_raw
          union all
          select false, -1, slot, d, sum(c)::int from counts_raw group by slot, d
          union all
          select false, class_num, -1, d, sum(c)::int from counts_raw group by class_num, d
          union all
          select false, -1, -1, d, sum(c)::int from counts_raw group by d
          union all
          select true, class_num, slot, d, c from counts_class
          union all
          select true, class_num, -1, d, sum(c)::int from counts_class group by class_num, d
          union all
          select true, -1, slot, d, sum(c)::int from counts_global group by slot, d
          union all
          select true, -1, -1, d, sum(c)::int from counts_global group by d
        ),
        -- class=Any denominators: per-item class count, and for merged groups
        -- the UNION of classes across members (engineer+spy builders etc.)
        own_classes as (
          select s.defindex, greatest(count(distinct c.c), 1)::int n
          from item_schema s cross join lateral unnest(s.used_by_classes) c(c)
          group by s.defindex
        ),
        group_classes as (
          select coalesce(s.reskin_group, s.defindex) gid, greatest(count(distinct c.c), 1)::int n
          from item_schema s cross join lateral unnest(s.used_by_classes) c(c)
          group by 1
        ),
        -- slot-specific denominators: Panic Attack in the primary slot is an
        -- engineer-only opportunity even though 4 classes own the item
        own_slot as (
          select defindex, slot, count(*)::int n from item_class_slots group by 1, 2
        ),
        group_slot as (
          select coalesce(s.reskin_group, ics.defindex) gid, ics.slot,
                 count(distinct ics.class_num)::int n
          from item_class_slots ics
          join item_schema s on s.defindex = ics.defindex
          group by 1, 2
        )
        insert into usage_stats
          (defindex, class_num, slot, active_minutes_2wk, minutes_threshold, merge_reskins,
           usage, count, sample_size, computed_at)
        select
          r.defindex, r.class_num, r.slot, ${pop.active2wk}, ${pop.minutes}, r.merged,
          -- class=Any divides by per-class equip opportunities (old styletf
          -- semantics); slot-specific rows use slot-specific class counts
          r.c::real / (t.n * case
            when r.class_num <> -1 then 1
            when r.slot = -1 then coalesce(case when r.merged then g.n else o.n end, 9)
            else coalesce(
              case when r.merged then gs.n else os.n end,
              case when r.merged then g.n else o.n end, 9) end),
          r.c, t.n, now()
        from rollups r
        cross join total t
        left join own_classes o on o.defindex = r.defindex
        left join group_classes g on g.gid = r.defindex
        left join own_slot os on os.defindex = r.defindex and os.slot = r.slot
        left join group_slot gs on gs.gid = r.defindex and gs.slot = r.slot
        where t.n > 0
      `);
    }
  });
}

/**
 * Snapshot the default headline usage view (Any class · Any slot · all players ·
 * merged) into usage_stats_history, one row per group keyed on today's UTC date.
 * Runs every cycle and upserts, so the day's row holds its latest value; this
 * powers the /usage delta-compare feature. Additive — no backfill, history
 * accrues from first deploy. Only the headline slice is retained, so the table
 * stays ~one row per item per day rather than mirroring the full usage cube.
 */
async function recordUsageHistory(): Promise<void> {
  await db.execute(sql`
    insert into usage_stats_history (defindex, day, usage, count, sample_size)
    select defindex, timezone('UTC', now())::date, usage, count, sample_size
    from usage_stats
    where class_num = -1 and slot = -1 and active_minutes_2wk = 0
      and minutes_threshold = 0 and merge_reskins = true
    on conflict (defindex, day) do update
      set usage = excluded.usage,
          count = excluded.count,
          sample_size = excluded.sample_size
  `);
}

/** avg points/min, kills/hr, dmg/min of players equipping each weapon group
 * per class (10h+ on the class, weapons slots only, class-aware merge ids) */
async function recomputeWeaponStats(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from weapon_class_stats`);
    await tx.execute(sql`
      insert into weapon_class_stats
        (defindex, class_num, players, avg_points_per_min, avg_kills_per_hour,
         avg_damage_per_min, computed_at)
      select
        case when coalesce(s.reskin_group, e.defindex) =
                  (select coalesce(reskin_group, 264) from item_schema where defindex = 264)
          then case e.class_num
            when 1 then 0 when 4 then 1 when 7 then 2 when 2 then 3 when 8 then 4
            when 6 then 5 when 3 then 6 when 9 then 7 when 5 then 8
            else coalesce(s.reskin_group, e.defindex) end
          else coalesce(s.reskin_group, e.defindex) end as gid,
        e.class_num,
        count(distinct e.steamid)::int,
        avg(p.points_scored::real * 60 / p.playtime_seconds),
        avg(p.kills::real * 3600 / p.playtime_seconds),
        avg(p.damage_dealt::real * 60 / p.playtime_seconds),
        now()
      from equipped_items e
      join player_class_stats p on p.steamid = e.steamid and p.class_num = e.class_num
      join players pl on pl.steamid = e.steamid
      left join item_schema s on s.defindex = e.defindex
      where e.slot <= 6 and p.playtime_seconds >= 36000
        and coalesce(pl.botness, 0) < 0.5
      group by 1, 2
      having count(distinct e.steamid) >= 3
    `);
  });
}

/**
 * top-100 per board across the whole metric × scope × kind × threshold grid
 * (boards.ts), plus per-board participant counts (percentile denominators)
 * into leaderboard_meta. Counts are identical for every metric in a
 * (scope, kind, threshold) cell, so they're cached on the count SQL text.
 */
async function recomputeLeaderboards(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from leaderboard_entries`);
    await tx.execute(sql`delete from leaderboard_meta`);
    const countCache = new Map<string, number>();
    for (const board of BOARDS) {
      await tx.execute(sql`
        insert into leaderboard_entries (board_key, rank, steamid, value)
        select ${board.key}, row_number() over (order by t.value desc, t.steamid), t.steamid, t.value
        from (${sql.raw(boardSelectSql(board, 100))}) t
      `);
      const countSql = boardCountSql(board);
      let participants = countCache.get(countSql);
      if (participants === undefined) {
        const rows = (await tx.execute(sql.raw(countSql))) as unknown as { n: number }[];
        participants = rows[0]?.n ?? 0;
        countCache.set(countSql, participants);
      }
      await tx.execute(sql`
        insert into leaderboard_meta (board_key, participants)
        values (${board.key}, ${participants})
      `);
    }
  });
}

async function main(): Promise<void> {
  console.log("analyser started");
  for (;;) {
    const start = Date.now();
    try {
      await recomputeBotness();
      await recompute();
      await recordUsageHistory();
      await recomputeWeaponStats();
      await recomputeLeaderboards();
      console.log(
        `botness + usage_stats (+ history) + weapon_class_stats + leaderboard_entries recomputed in ${Date.now() - start}ms`,
      );
    } catch (err) {
      console.error("analyser run failed:", err);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}

await main();

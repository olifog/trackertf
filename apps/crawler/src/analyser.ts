/**
 * Recomputes usage_stats from equipped_items for every filter combination:
 * 4 populations (active × experienced) × all class/slot rollups × merge modes.
 * Replaces styletf's 400-combo Mongo cartesian product with 4 SQL passes.
 */
import { createDbFromEnv } from "@trackertf/db";
import { sql } from "drizzle-orm";

const db = createDbFromEnv();
const INTERVAL_MS = 15 * 60_000;
const EXPERIENCED_MINUTES = 120_000;

const POPULATIONS = [
  { active: false, minutes: 0 },
  { active: true, minutes: 0 },
  { active: false, minutes: EXPERIENCED_MINUTES },
  { active: true, minutes: EXPERIENCED_MINUTES },
] as const;

async function recompute(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from usage_stats`);
    for (const pop of POPULATIONS) {
      await tx.execute(sql`
        with pop as (
          select p.steamid from players p
          where p.items_status = 'ok'
            and (${pop.active} = false or coalesce(p.tf2_minutes_2wk, 0) > 0)
            and coalesce(p.tf2_minutes, 0) > ${pop.minutes}
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
        )
        insert into usage_stats
          (defindex, class_num, slot, active_only, minutes_threshold, merge_reskins,
           usage, count, sample_size, computed_at)
        select
          r.defindex, r.class_num, r.slot, ${pop.active}, ${pop.minutes}, r.merged,
          -- class=Any divides by per-class equip opportunities (old styletf semantics)
          r.c::real / (t.n * case when r.class_num = -1
            then coalesce(case when r.merged then g.n else o.n end, 9) else 1 end),
          r.c, t.n, now()
        from rollups r
        cross join total t
        left join own_classes o on o.defindex = r.defindex
        left join group_classes g on g.gid = r.defindex
        where t.n > 0
      `);
    }
  });
}

async function main(): Promise<void> {
  console.log("analyser started");
  for (;;) {
    const start = Date.now();
    try {
      await recompute();
      console.log(`usage_stats recomputed in ${Date.now() - start}ms`);
    } catch (err) {
      console.error("analyser run failed:", err);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}

await main();

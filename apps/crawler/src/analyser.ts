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
        eq as (
          select e.steamid, e.class_num, e.slot, e.defindex as raw_defindex,
                 coalesce(s.reskin_group, e.defindex) as merged_defindex
          from equipped_items e
          join pop using (steamid)
          left join item_schema s on s.defindex = e.defindex
        ),
        counts as (
          select false as merged, class_num, slot, raw_defindex as defindex, count(*)::int c
          from eq group by class_num, slot, raw_defindex
          union all
          select true, class_num, slot, merged_defindex, count(*)::int
          from eq group by class_num, slot, merged_defindex
        ),
        rollups as (
          select merged, class_num, slot, defindex, c from counts
          union all
          select merged, -1, slot, defindex, sum(c)::int from counts group by merged, slot, defindex
          union all
          select merged, class_num, -1, defindex, sum(c)::int from counts group by merged, class_num, defindex
          union all
          select merged, -1, -1, defindex, sum(c)::int from counts group by merged, defindex
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

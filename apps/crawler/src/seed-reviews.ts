/**
 * Seed the crawl frontier from Steam store reviews of TF2 (keyless endpoint,
 * ~100 authors/page, casual-skewed — counters friend-BFS connectivity bias).
 * Usage: bun run src/seed-reviews.ts [target=3000]
 */
import { createDbFromEnv } from "@trackertf/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

const target = Number(process.argv[2] ?? 3000);
const db = createDbFromEnv();

const pageSchema = z.object({
  success: z.number(),
  cursor: z.string().optional(),
  reviews: z.array(z.object({ author: z.object({ steamid: z.string() }) })),
});

let cursor = "*";
const seen = new Set<string>();
let inserted = 0;

while (seen.size < target) {
  const url =
    "https://store.steampowered.com/appreviews/440?json=1&filter=recent&language=all" +
    `&purchase_type=all&review_type=all&num_per_page=100&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`appreviews HTTP ${res.status}`);
  const page = pageSchema.parse(await res.json());
  if (page.reviews.length === 0 || !page.cursor || page.cursor === cursor) break;
  cursor = page.cursor;

  const fresh = page.reviews.map((r) => r.author.steamid).filter((s) => !seen.has(s));
  fresh.forEach((s) => seen.add(s));
  if (fresh.length > 0) {
    const result = await db.execute(sql`
      insert into crawl_frontier (steamid, source)
      select t.steamid, 'review_sample'::frontier_source
      from jsonb_array_elements_text(${JSON.stringify(fresh)}::jsonb) as t(steamid)
      where not exists (select 1 from players p where p.steamid = t.steamid)
      on conflict (steamid) do nothing
    `);
    inserted += result.count ?? 0;
  }
  console.log(`collected ${seen.size}/${target} (enqueued ${inserted})`);
  await Bun.sleep(1_500);
}

console.log(`done: ${seen.size} authors seen, ${inserted} enqueued`);
process.exit(0);

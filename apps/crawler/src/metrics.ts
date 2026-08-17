/** Buffered hourly API-outcome counters flushed to api_metrics. */
import type { Db } from "@trackertf/db";
import { sql } from "drizzle-orm";

const buffer = new Map<string, number>();

export function record(endpoint: string, outcome: string): void {
  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  const key = `${hour.toISOString()}|${endpoint}|${outcome}`;
  buffer.set(key, (buffer.get(key) ?? 0) + 1);
}

export async function flushMetrics(db: Db): Promise<void> {
  if (buffer.size === 0) return;
  const entries = [...buffer.entries()].map(([key, count]) => {
    const [hour, endpoint, outcome] = key.split("|");
    return [hour, endpoint, outcome, count];
  });
  buffer.clear();
  await db.execute(sql`
    insert into api_metrics (hour, endpoint, outcome, count)
    select (e ->> 0)::timestamptz, e ->> 1, e ->> 2, (e -> 3)::int
    from jsonb_array_elements(${JSON.stringify(entries)}::jsonb) e
    on conflict (hour, endpoint, outcome)
    do update set count = api_metrics.count + excluded.count
  `);
}

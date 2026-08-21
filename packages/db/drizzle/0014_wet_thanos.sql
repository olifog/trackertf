ALTER TABLE "stat_windows" ADD COLUMN "stat_deltas" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_windows" ADD COLUMN "loadout" jsonb;--> statement-breakpoint
ALTER TABLE "stat_windows" ADD COLUMN "loadout_stable" boolean DEFAULT false NOT NULL;
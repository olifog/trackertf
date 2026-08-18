CREATE TABLE "leaderboard_meta" (
	"board_key" text PRIMARY KEY NOT NULL,
	"participants" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"segment_id" bigint NOT NULL,
	"name" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"first_score" integer NOT NULL,
	"last_score" integer NOT NULL,
	"max_score" integer NOT NULL,
	"first_time_played" real NOT NULL,
	"last_time_played" real NOT NULL,
	"observations" smallint NOT NULL,
	CONSTRAINT "match_participants_segment_id_name_pk" PRIMARY KEY("segment_id","name")
);
--> statement-breakpoint
CREATE TABLE "match_segments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_steamid" text NOT NULL,
	"map" text NOT NULL,
	"region" smallint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"observations" smallint NOT NULL
);
--> statement-breakpoint
-- usage_stats is a fully-recomputed derived table; its rows use the obsolete
-- 4-population scheme, so truncate before switching active_only -> active_minutes_2wk.
-- The analyser repopulates it on its next 15-min cycle.
TRUNCATE "usage_stats";--> statement-breakpoint
DROP INDEX "usage_stats_key_idx";--> statement-breakpoint
DROP INDEX "usage_stats_filter_idx";--> statement-breakpoint
ALTER TABLE "equipped_items" ADD COLUMN "quality" smallint DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_stats" ADD COLUMN "active_minutes_2wk" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_segment_id_match_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."match_segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_segments_started_at_idx" ON "match_segments" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_stats_key_idx" ON "usage_stats" USING btree ("defindex","class_num","slot","active_minutes_2wk","minutes_threshold","merge_reskins");--> statement-breakpoint
CREATE INDEX "usage_stats_filter_idx" ON "usage_stats" USING btree ("class_num","slot","active_minutes_2wk","minutes_threshold","merge_reskins");--> statement-breakpoint
ALTER TABLE "usage_stats" DROP COLUMN "active_only";
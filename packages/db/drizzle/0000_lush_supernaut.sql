CREATE TYPE "public"."fetch_status" AS ENUM('ok', 'private', 'not_found', 'empty', 'error');--> statement-breakpoint
CREATE TYPE "public"."frontier_source" AS ENUM('seed', 'friend_bfs', 'review_sample', 'random_sample', 'recrawl');--> statement-breakpoint
CREATE TABLE "crawl_frontier" (
	"steamid" text PRIMARY KEY NOT NULL,
	"source" "frontier_source" NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "equipped_items" (
	"steamid" text NOT NULL,
	"defindex" integer NOT NULL,
	"class_num" smallint NOT NULL,
	"slot" smallint NOT NULL,
	CONSTRAINT "equipped_items_steamid_class_num_slot_defindex_pk" PRIMARY KEY("steamid","class_num","slot","defindex")
);
--> statement-breakpoint
CREATE TABLE "item_schema" (
	"defindex" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"item_name" text,
	"image_url" text,
	"slot" text,
	"used_by_classes" smallint[] NOT NULL,
	"equip_regions" text[],
	"reskin_group" integer
);
--> statement-breakpoint
CREATE TABLE "player_class_stats" (
	"steamid" text NOT NULL,
	"class_num" smallint NOT NULL,
	"playtime_seconds" bigint DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"kill_assists" integer DEFAULT 0 NOT NULL,
	"damage_dealt" bigint DEFAULT 0 NOT NULL,
	"points_scored" integer DEFAULT 0 NOT NULL,
	"dominations" integer DEFAULT 0 NOT NULL,
	"captures" integer DEFAULT 0 NOT NULL,
	"defenses" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_class_stats_steamid_class_num_pk" PRIMARY KEY("steamid","class_num")
);
--> statement-breakpoint
CREATE TABLE "player_friends_raw" (
	"steamid" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_items_raw" (
	"steamid" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_stats_raw" (
	"steamid" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"steamid" text PRIMARY KEY NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "frontier_source",
	"last_crawled" timestamp with time zone,
	"personaname" text,
	"avatar_hash" text,
	"visibility" smallint,
	"tf2_minutes" integer,
	"tf2_minutes_2wk" integer,
	"vac_banned" boolean,
	"game_bans" smallint,
	"items_status" "fetch_status",
	"stats_status" "fetch_status",
	"friends_status" "fetch_status"
);
--> statement-breakpoint
CREATE TABLE "server_snapshots" (
	"scanned_at" timestamp with time zone NOT NULL,
	"map" text NOT NULL,
	"region" smallint NOT NULL,
	"official" boolean NOT NULL,
	"server_count" integer NOT NULL,
	"players" integer NOT NULL,
	"bots" integer NOT NULL,
	CONSTRAINT "server_snapshots_scanned_at_map_region_official_pk" PRIMARY KEY("scanned_at","map","region","official")
);
--> statement-breakpoint
CREATE TABLE "usage_stats" (
	"defindex" integer NOT NULL,
	"class_num" smallint NOT NULL,
	"slot" smallint NOT NULL,
	"active_only" boolean NOT NULL,
	"minutes_threshold" integer NOT NULL,
	"merge_reskins" boolean NOT NULL,
	"usage" real NOT NULL,
	"sample_size" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "equipped_items" ADD CONSTRAINT "equipped_items_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_class_stats" ADD CONSTRAINT "player_class_stats_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_friends_raw" ADD CONSTRAINT "player_friends_raw_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_items_raw" ADD CONSTRAINT "player_items_raw_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats_raw" ADD CONSTRAINT "player_stats_raw_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_frontier_dequeue_idx" ON "crawl_frontier" USING btree ("priority","enqueued_at");--> statement-breakpoint
CREATE INDEX "equipped_items_defindex_idx" ON "equipped_items" USING btree ("defindex");--> statement-breakpoint
CREATE INDEX "players_last_crawled_idx" ON "players" USING btree ("last_crawled");--> statement-breakpoint
CREATE INDEX "server_snapshots_scanned_at_idx" ON "server_snapshots" USING btree ("scanned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_stats_key_idx" ON "usage_stats" USING btree ("defindex","class_num","slot","active_only","minutes_threshold","merge_reskins");--> statement-breakpoint
CREATE INDEX "usage_stats_filter_idx" ON "usage_stats" USING btree ("class_num","slot","active_only","minutes_threshold","merge_reskins");
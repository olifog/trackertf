CREATE TABLE "segment_attributions" (
	"segment_id" bigint NOT NULL,
	"name" text NOT NULL,
	"steamid" text NOT NULL,
	"confidence" real NOT NULL,
	"similarity" real NOT NULL,
	"exact_name" boolean NOT NULL,
	"recently_active" boolean NOT NULL,
	"delta_corroborated" boolean NOT NULL,
	"strong" boolean NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_attributions_segment_id_name_pk" PRIMARY KEY("segment_id","name")
);
--> statement-breakpoint
CREATE TABLE "stat_windows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steamid" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"playtime_delta_sec" integer DEFAULT 0 NOT NULL,
	"reset" boolean DEFAULT false NOT NULL,
	"upload_lag" boolean DEFAULT false NOT NULL,
	"pure_map" boolean DEFAULT false NOT NULL,
	"pure_class" boolean DEFAULT false NOT NULL,
	"map" text,
	"class_deltas" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_class_playtime" (
	"map" text NOT NULL,
	"class_num" smallint NOT NULL,
	"playtime_seconds" bigint DEFAULT 0 NOT NULL,
	"windows" integer DEFAULT 0 NOT NULL,
	"players" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "map_class_playtime_map_class_num_pk" PRIMARY KEY("map","class_num")
);
--> statement-breakpoint
ALTER TABLE "segment_attributions" ADD CONSTRAINT "segment_attributions_segment_id_match_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."match_segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_attributions" ADD CONSTRAINT "segment_attributions_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_windows" ADD CONSTRAINT "stat_windows_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_attributions_steamid_idx" ON "segment_attributions" USING btree ("steamid");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_windows_key_idx" ON "stat_windows" USING btree ("steamid","started_at","ended_at");--> statement-breakpoint
CREATE INDEX "stat_windows_ended_at_idx" ON "stat_windows" USING btree ("ended_at");

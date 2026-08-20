CREATE TABLE "usage_stats_history" (
	"defindex" integer NOT NULL,
	"day" date NOT NULL,
	"usage" real NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"sample_size" integer NOT NULL,
	CONSTRAINT "usage_stats_history_defindex_day_pk" PRIMARY KEY("defindex","day")
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "loccountrycode" text;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_personaname_trgm_idx" ON "players" USING gin (lower("personaname") gin_trgm_ops);
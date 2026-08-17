CREATE TABLE "player_stat_snapshots" (
	"steamid" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"loadout" jsonb,
	"tf2_minutes" integer,
	CONSTRAINT "player_stat_snapshots_steamid_fetched_at_pk" PRIMARY KEY("steamid","fetched_at")
);

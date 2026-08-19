CREATE TABLE "server_empty_snapshots" (
	"scanned_at" timestamp with time zone NOT NULL,
	"region" smallint NOT NULL,
	"servers" integer NOT NULL,
	"capacity" integer NOT NULL,
	CONSTRAINT "server_empty_snapshots_scanned_at_region_pk" PRIMARY KEY("scanned_at","region")
);
--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "capacity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "alltalk_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "nocrits_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "respawntimes_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "maxplayers_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD COLUMN "highlander_servers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "server_empty_snapshots_scanned_at_idx" ON "server_empty_snapshots" USING btree ("scanned_at");
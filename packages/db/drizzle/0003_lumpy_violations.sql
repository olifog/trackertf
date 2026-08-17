CREATE TABLE "api_metrics" (
	"hour" timestamp with time zone NOT NULL,
	"endpoint" text NOT NULL,
	"outcome" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_metrics_hour_endpoint_outcome_pk" PRIMARY KEY("hour","endpoint","outcome")
);
--> statement-breakpoint
CREATE TABLE "weapon_class_stats" (
	"defindex" integer NOT NULL,
	"class_num" smallint NOT NULL,
	"players" integer NOT NULL,
	"avg_points_per_min" real NOT NULL,
	"avg_kills_per_hour" real NOT NULL,
	"avg_damage_per_min" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weapon_class_stats_defindex_class_num_pk" PRIMARY KEY("defindex","class_num")
);

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
CREATE TABLE "steam_budget" (
	"class" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"capacity" double precision NOT NULL,
	"refill_per_sec" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "equipped_items" ADD COLUMN "renamed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "segment_attributions" ADD CONSTRAINT "segment_attributions_segment_id_match_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."match_segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_attributions" ADD CONSTRAINT "segment_attributions_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_windows" ADD CONSTRAINT "stat_windows_steamid_players_steamid_fk" FOREIGN KEY ("steamid") REFERENCES "public"."players"("steamid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_attributions_steamid_idx" ON "segment_attributions" USING btree ("steamid");--> statement-breakpoint
CREATE UNIQUE INDEX "stat_windows_key_idx" ON "stat_windows" USING btree ("steamid","started_at","ended_at");--> statement-breakpoint
CREATE INDEX "stat_windows_ended_at_idx" ON "stat_windows" USING btree ("ended_at");--> statement-breakpoint
INSERT INTO "steam_budget" ("class", "tokens", "capacity", "refill_per_sec") VALUES
	('crawler', 10, 10, 0.40),
	('sampler', 45, 45, 0.25),
	('scanner', 6, 6, 0.05),
	('web', 5, 5, 0.10),
	('_shared', 20, 20, 0.30)
ON CONFLICT ("class") DO NOTHING;--> statement-breakpoint
-- Atomic hierarchical-token-bucket admission. Locks the class row and the
-- shared row (class-then-shared ordering is deadlock-free: shared is always
-- acquired last), refills both by wall-clock elapsed, then debits the class
-- bucket if it has a whole token (guaranteed floor), else the shared bucket
-- (borrowed surplus). Returns ok=false plus wait_ms = time until the sooner of
-- the two buckets next holds a token, so callers can sleep exactly that long.
-- SECURITY DEFINER so read-only web_ro can execute it without table writes.
CREATE OR REPLACE FUNCTION steam_budget_take(p_class text)
RETURNS TABLE(ok boolean, wait_ms integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
	v_now timestamptz := clock_timestamp();
	c_tokens double precision; c_cap double precision; c_rate double precision; c_upd timestamptz;
	s_tokens double precision; s_cap double precision; s_rate double precision; s_upd timestamptz;
	s_exists boolean := false;
BEGIN
	SELECT tokens, capacity, refill_per_sec, updated_at
		INTO c_tokens, c_cap, c_rate, c_upd
		FROM steam_budget WHERE class = p_class FOR UPDATE;
	IF NOT FOUND THEN
		-- unknown class: fail open so a misconfiguration can't wedge a caller
		RETURN QUERY SELECT true, 0;
		RETURN;
	END IF;

	SELECT tokens, capacity, refill_per_sec, updated_at
		INTO s_tokens, s_cap, s_rate, s_upd
		FROM steam_budget WHERE class = '_shared' FOR UPDATE;
	s_exists := FOUND;

	c_tokens := least(c_cap, c_tokens + extract(epoch FROM (v_now - c_upd)) * c_rate);
	IF s_exists THEN
		s_tokens := least(s_cap, s_tokens + extract(epoch FROM (v_now - s_upd)) * s_rate);
	END IF;

	IF c_tokens >= 1 THEN
		UPDATE steam_budget
			SET tokens = c_tokens - 1, updated_at = v_now, consumed_total = consumed_total + 1
			WHERE class = p_class;
		RETURN QUERY SELECT true, 0;
		RETURN;
	ELSIF s_exists AND s_tokens >= 1 THEN
		UPDATE steam_budget
			SET tokens = s_tokens - 1, updated_at = v_now, consumed_total = consumed_total + 1
			WHERE class = '_shared';
		RETURN QUERY SELECT true, 0;
		RETURN;
	ELSE
		RETURN QUERY SELECT false, greatest(1, ceil(1000 * least(
			CASE WHEN c_rate > 0 THEN (1 - c_tokens) / c_rate ELSE 1e9 END,
			CASE WHEN s_exists AND s_rate > 0 THEN (1 - s_tokens) / s_rate ELSE 1e9 END
		))::integer);
		RETURN;
	END IF;
END;
$$;
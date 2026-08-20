CREATE TABLE "steam_budget" (
	"class" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"capacity" double precision NOT NULL,
	"refill_per_sec" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_total" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO "steam_budget" ("class", "tokens", "capacity", "refill_per_sec") VALUES
	('crawler', 10, 10, 0.40),
	('sampler', 45, 45, 0.25),
	('scanner', 6, 6, 0.05),
	('web', 5, 5, 0.10),
	('_shared', 20, 20, 0.30)
ON CONFLICT ("class") DO NOTHING;
--> statement-breakpoint
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

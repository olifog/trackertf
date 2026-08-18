CREATE TABLE "leaderboard_entries" (
	"board_key" text NOT NULL,
	"rank" integer NOT NULL,
	"steamid" text NOT NULL,
	"value" real NOT NULL,
	CONSTRAINT "leaderboard_entries_board_key_rank_pk" PRIMARY KEY("board_key","rank")
);

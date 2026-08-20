import { z } from "zod";

export const playerSummarySchema = z.object({
  steamid: z.string(),
  personaname: z.string(),
  communityvisibilitystate: z.number(),
  avatarhash: z.string().optional(),
  profileurl: z.string().optional(),
  /** ISO 3166-1 alpha-2, only present on public profiles that set a country */
  loccountrycode: z.string().optional(),
});
export type PlayerSummary = z.infer<typeof playerSummarySchema>;

export const getPlayerSummariesResponse = z.object({
  response: z.object({ players: z.array(playerSummarySchema) }),
});

export const ownedGameSchema = z.object({
  appid: z.number(),
  playtime_forever: z.number(),
  playtime_2weeks: z.number().optional(),
});

export const getOwnedGamesResponse = z.object({
  response: z.object({
    game_count: z.number().optional(),
    games: z.array(ownedGameSchema).optional(),
  }),
});

export const equipInfoSchema = z.object({
  class: z.number(),
  slot: z.number(),
});

// Steam encodes some attribute values as numeric strings (e.g. kill_eater
// counts, account ids) and others as non-numeric text (custom names, urls).
// We only care about the numeric ones, so coerce and fall back to undefined
// for anything that isn't a number rather than rejecting the whole item.
const numericAttr = z.coerce.number().optional().catch(undefined);
export const itemAttributeSchema = z.object({
  defindex: z.number(),
  value: numericAttr,
  float_value: numericAttr,
});

export const backpackItemSchema = z.object({
  id: z.number(),
  original_id: z.number().optional(),
  defindex: z.number(),
  level: z.number().optional(),
  quality: z.number().optional(),
  quantity: z.number().optional(),
  // present (any string, incl. empty) only when the owner applied a Name Tag —
  // GetPlayerItems omits the field entirely for un-renamed items
  custom_name: z.string().optional(),
  equipped: z.array(equipInfoSchema).optional(),
  attributes: z.array(itemAttributeSchema).optional(),
});
export type BackpackItem = z.infer<typeof backpackItemSchema>;

/** status 1 = ok, 15 = backpack private, 18 = steamid does not exist */
export const getPlayerItemsResponse = z.object({
  result: z.object({
    status: z.number(),
    num_backpack_slots: z.number().optional(),
    items: z.array(backpackItemSchema).optional(),
  }),
});

export const userStatSchema = z.object({
  name: z.string(),
  value: z.number(),
});

export const getUserStatsResponse = z.object({
  playerstats: z.object({
    steamID: z.string().optional(),
    stats: z.array(userStatSchema).optional(),
  }),
});

export const friendSchema = z.object({
  steamid: z.string(),
  friend_since: z.number(),
});
export type Friend = z.infer<typeof friendSchema>;

export const getFriendListResponse = z.object({
  friendslist: z.object({ friends: z.array(friendSchema) }),
});

export const gameServerSchema = z.object({
  addr: z.string(),
  gameport: z.number(),
  steamid: z.string(),
  name: z.string(),
  map: z.string(),
  gametype: z.string().optional(),
  region: z.number().optional(),
  players: z.number(),
  max_players: z.number(),
  bots: z.number(),
  secure: z.boolean().optional(),
  dedicated: z.boolean().optional(),
});
export type GameServer = z.infer<typeof gameServerSchema>;

export const getServerListResponse = z.object({
  response: z.object({ servers: z.array(gameServerSchema).optional() }),
});

export const playerBanSchema = z.object({
  SteamId: z.string(),
  VACBanned: z.boolean(),
  NumberOfVACBans: z.number(),
  NumberOfGameBans: z.number(),
});

export const getPlayerBansResponse = z.object({
  players: z.array(playerBanSchema),
});

export const fakeIpPlayerSchema = z.object({
  name: z.string(),
  score: z.number(),
  time_played: z.number(),
});
export type FakeIpPlayer = z.infer<typeof fakeIpPlayerSchema>;

export const queryByFakeIpPlayersResponse = z.object({
  response: z.object({
    players_data: z.object({ players: z.array(fakeIpPlayerSchema).optional() }).optional(),
  }),
});

export const queryByFakeIpRulesResponse = z.object({
  response: z.object({
    rules_data: z
      .object({
        rules: z.array(z.object({ rule: z.string(), value: z.string() })).optional(),
      })
      .optional(),
  }),
});

export const resolveVanityResponse = z.object({
  response: z.object({ success: z.number(), steamid: z.string().optional() }),
});

/** GetNumberOfCurrentPlayers: result 1 = ok. Live concurrent players for an app. */
export const getNumberOfCurrentPlayersResponse = z.object({
  response: z.object({ result: z.number().optional(), player_count: z.number() }),
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { schema } from "@trackertf/db";
import { eq } from "drizzle-orm";
import { getDb } from "./db.ts";

export const SESSION_COOKIE = "tf_session";
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

let warnedDevSecret = false;
function sessionSecret(): string {
  const secret = process.env["SESSION_SECRET"];
  if (secret) return secret;
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn("SESSION_SECRET is not set — falling back to an insecure dev default");
  }
  return "trackertf-dev-secret";
}

function hmac(steamid: string): string {
  return createHmac("sha256", sessionSecret()).update(steamid).digest("hex");
}

/** `<steamid>.<hmac-sha256(steamid, SESSION_SECRET)>` */
export function signSession(steamid: string): string {
  return `${steamid}.${hmac(steamid)}`;
}

/** Returns the steamid64 if the cookie value carries a valid signature. */
export function verifySession(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot === -1) return null;
  const steamid = value.slice(0, dot);
  if (!/^\d{17}$/.test(steamid)) return null;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(hmac(steamid));
  return given.length === expected.length && timingSafeEqual(given, expected) ? steamid : null;
}

export function sessionSetCookie(steamid: string): string {
  return `${SESSION_COOKIE}=${signSession(steamid)}; Max-Age=${THIRTY_DAYS_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export const getSession = createServerFn({ method: "GET" }).handler(
  (): { steamid: string } | null => {
    const steamid = verifySession(getCookie(SESSION_COOKIE));
    return steamid ? { steamid } : null;
  },
);

export interface SessionUser {
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
}

/** Session + profile basics from the players table (null fields if not crawled yet). */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    const steamid = verifySession(getCookie(SESSION_COOKIE));
    if (!steamid) return null;
    const [p] = await getDb()
      .select({
        personaname: schema.players.personaname,
        avatarHash: schema.players.avatarHash,
      })
      .from(schema.players)
      .where(eq(schema.players.steamid, steamid))
      .limit(1);
    return { steamid, personaname: p?.personaname ?? null, avatarHash: p?.avatarHash ?? null };
  },
);

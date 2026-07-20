import { base64UrlDecode, base64UrlEncode, hmacSha256, safeEqual } from "./crypto";
import type { SessionIdentity } from "./types";

interface SessionPayload extends SessionIdentity {
  exp: number;
}

export async function createSessionToken(identity: SessionIdentity, secret: string): Promise<string> {
  const payload: SessionPayload = {
    ...identity,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(await hmacSha256(secret, body));
  return `${body}.${signature}`;
}

export async function verifySessionToken(token: string | null, secret: string): Promise<SessionIdentity | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = base64UrlEncode(await hmacSha256(secret, body));
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(body)) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      sub: payload.sub,
      kind: "telegram",
      telegramUserId: payload.telegramUserId,
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      isAdmin: payload.isAdmin,
    };
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

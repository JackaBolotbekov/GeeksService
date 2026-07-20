import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionIdentity } from "../shared/types";

const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

interface SessionPayload extends SessionIdentity {
  exp: number;
}

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createSessionToken(
  identity: SessionIdentity,
  secret: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: SessionPayload = {
    ...identity,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifySessionToken(token: string, secret: string): SessionIdentity | null {
  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) return null;

  const expectedSignature = sign(encodedPayload, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      sub: payload.sub,
      kind: payload.kind,
      telegramUserId: payload.telegramUserId,
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      isAdmin: Boolean(payload.isAdmin),
    };
  } catch {
    return null;
  }
}

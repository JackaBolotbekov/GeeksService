import { getEnv, isAdminTelegramUser } from "./env";
import { bearerToken, verifySessionToken } from "./session";
import type { SessionIdentity } from "./types";

export function jsonError(message: string, status = 400): Response {
  return Response.json({ message }, { status });
}

export async function requireIdentity(request: Request): Promise<SessionIdentity | Response> {
  const secret = getEnv("SESSION_SECRET") ?? "geeks-service-sites-local-secret";
  const identity = await verifySessionToken(bearerToken(request), secret);
  if (!identity) return jsonError("Требуется вход через Telegram", 401);
  return {
    ...identity,
    isAdmin: identity.isAdmin || isAdminTelegramUser(identity.telegramUserId),
  };
}

export async function requireAdmin(request: Request): Promise<SessionIdentity | Response> {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;
  if (!identity.isAdmin) return jsonError("Только админ может менять учеников и оценки", 403);
  return identity;
}

export function parseTelegramContact(input: {
  telegram?: string | null;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
}): { telegramUserId?: string | null; telegramUsername?: string | null } {
  const explicitId = cleanNullableText(input.telegramUserId);
  const explicitUsername = cleanNullableText(input.telegramUsername);
  const contact = cleanNullableText(input.telegram);
  if (!contact) {
    return {
      telegramUserId: explicitId,
      telegramUsername: explicitUsername,
    };
  }
  if (/^\d{1,20}$/.test(contact)) {
    return {
      telegramUserId: contact,
      telegramUsername: explicitUsername,
    };
  }
  return {
    telegramUserId: explicitId,
    telegramUsername: contact,
  };
}

export function cleanNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

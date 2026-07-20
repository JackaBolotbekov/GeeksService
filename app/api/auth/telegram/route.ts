import { getEnv, isAdminTelegramUser } from "@/lib/env";
import { jsonError } from "@/lib/api";
import { createSessionToken } from "@/lib/session";
import { publicTelegramAvatar, telegramDisplayName, validateTelegramInitData } from "@/lib/telegram";
import { upsertTelegramStudent } from "@/lib/store";
import type { AuthResponse, SessionIdentity } from "@/lib/types";

export async function POST(request: Request) {
  const botToken = getEnv("BOT_TOKEN");
  if (!botToken) return jsonError("Telegram-вход пока не настроен", 503);

  const body = await request.json().catch(() => null) as { initData?: string } | null;
  if (!body?.initData) return jsonError("Telegram initData отсутствует", 400);

  try {
    const telegramUser = await validateTelegramInitData(body.initData, botToken);
    const telegramUserId = String(telegramUser.id);
    const isAdmin = isAdminTelegramUser(telegramUserId);
    const displayName = telegramDisplayName(telegramUser);
    const avatarUrl = telegramUser.photo_url ?? publicTelegramAvatar(telegramUser.username);
    const student = isAdmin
      ? null
      : await upsertTelegramStudent({
          telegramUserId,
          telegramUsername: telegramUser.username ?? null,
          displayName,
          avatarUrl,
        });
    const identity: SessionIdentity = {
      sub: `telegram:${telegramUserId}`,
      kind: "telegram",
      telegramUserId,
      displayName: student?.displayName ?? displayName,
      avatarUrl: student?.avatarUrl ?? avatarUrl,
      isAdmin,
    };
    const response: AuthResponse = {
      sessionToken: await createSessionToken(identity, getEnv("SESSION_SECRET") ?? "geeks-service-sites-local-secret"),
      profile: {
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        kind: "telegram",
        isAdmin,
      },
    };
    return Response.json(response);
  } catch {
    return jsonError("Не удалось подтвердить вход через Telegram", 401);
  }
}

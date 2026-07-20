import { bytesToHex, hmacSha256, safeEqual } from "./crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export function telegramDisplayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || `Ученик ${user.id}`;
}

export function normalizeTelegramUsername(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  return normalized || null;
}

export function publicTelegramAvatar(username: string | null | undefined): string | null {
  const normalized = normalizeTelegramUsername(username);
  return normalized ? `https://t.me/i/userpic/320/${encodeURIComponent(normalized)}.jpg` : null;
}

export async function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 60 * 60 * 24,
): Promise<TelegramUser> {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram hash is missing");

  params.delete("hash");
  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || now - authDate > maxAgeSeconds || authDate > now + 60) {
    throw new Error("Telegram authorization data is expired");
  }

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmacSha256("WebAppData", botToken);
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (!safeEqual(receivedHash, calculatedHash)) {
    throw new Error("Telegram authorization data is invalid");
  }

  const rawUser = params.get("user");
  if (!rawUser) throw new Error("Telegram user is missing");
  const user = JSON.parse(rawUser) as Partial<TelegramUser>;
  if (!user.id || !user.first_name) throw new Error("Telegram user is invalid");
  return user as TelegramUser;
}

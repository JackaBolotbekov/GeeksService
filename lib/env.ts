import { env } from "cloudflare:workers";

type RuntimeEnv = Record<string, string | undefined>;

export function getEnv(key: string): string | undefined {
  const runtime = env as unknown as RuntimeEnv;
  return runtime[key] ?? process.env[key];
}

export function getAdminTelegramIds(): Set<string> {
  return new Set(
    (getEnv("ADMIN_TELEGRAM_IDS") ?? "1291298838")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function isAdminTelegramUser(telegramUserId: string): boolean {
  return getAdminTelegramIds().has(telegramUserId);
}

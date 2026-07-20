import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramUserProfilePhotos {
  total_count: number;
  photos: TelegramPhotoSize[][];
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo?: {
    small_file_id: string;
    small_file_unique_id: string;
    big_file_id: string;
    big_file_unique_id: string;
  };
}

export interface ResolvedTelegramUser {
  telegramUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export function defaultAvatarStorageDir(databaseUrl = process.env.DATABASE_URL): string {
  return process.env.AVATAR_STORAGE_DIR ?? (databaseUrl?.startsWith("file:/data/") ? "/data/avatars" : resolve(".data/avatars"));
}

function extensionFromContentType(contentType: string | null): string {
  if (!contentType) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
}

function safeTelegramFileName(telegramUserId: string, sourceId: string, extension: string): string {
  const hash = createHash("sha256").update(sourceId).digest("hex").slice(0, 18);
  return `tg-${telegramUserId}-${hash}${extension}`;
}

async function telegramApi<T>(botToken: string, method: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`https://api.telegram.org/bot${botToken}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json() as TelegramApiResponse<T>;
  return data.ok && data.result ? data.result : null;
}

async function persistAvatar(storageDir: string, telegramUserId: string, sourceId: string, response: Response, fallbackExtension: string): Promise<string | null> {
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 2_000_000) return null;

  const contentType = response.headers.get("content-type");
  const extension = fallbackExtension || extensionFromContentType(contentType);
  const filename = safeTelegramFileName(telegramUserId, sourceId, extension);
  await mkdir(storageDir, { recursive: true });
  await writeFile(join(storageDir, filename), bytes);
  return `/avatars/${filename}`;
}

async function downloadTelegramFile(botToken: string, telegramUserId: string, storageDir: string, fileId: string, sourceId: string): Promise<string | null> {
  const file = await telegramApi<TelegramFile>(botToken, "getFile", { file_id: fileId });
  if (!file?.file_path) return null;

  const extension = extname(file.file_path) || ".jpg";
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(downloadUrl);
  return persistAvatar(storageDir, telegramUserId, sourceId, response, extension);
}

async function fetchViaBotApi(botToken: string, telegramUserId: string, storageDir: string): Promise<string | null> {
  const photos = await telegramApi<TelegramUserProfilePhotos>(botToken, "getUserProfilePhotos", {
    user_id: telegramUserId,
    limit: "1",
  });
  const photo = photos?.photos[0] ? [...photos.photos[0]].sort((left, right) => (right.width * right.height) - (left.width * left.height))[0] : null;
  if (!photo) return null;

  return downloadTelegramFile(botToken, telegramUserId, storageDir, photo.file_id, photo.file_unique_id);
}

async function fetchSignedPhotoUrl(photoUrl: string, telegramUserId: string, storageDir: string): Promise<string | null> {
  const url = new URL(photoUrl);
  if (url.protocol !== "https:") return null;
  const response = await fetch(url);
  const extension = extname(basename(url.pathname)) || extensionFromContentType(response.headers.get("content-type"));
  return persistAvatar(storageDir, telegramUserId, photoUrl, response, extension);
}

export async function resolveTelegramAvatarUrl(input: {
  botToken: string;
  telegramUserId: string;
  initPhotoUrl?: string | null;
  storageDir?: string;
}): Promise<string | null> {
  const storageDir = input.storageDir ?? defaultAvatarStorageDir();

  try {
    const botAvatar = await fetchViaBotApi(input.botToken, input.telegramUserId, storageDir);
    if (botAvatar) return botAvatar;
  } catch {
    console.warn("Telegram Bot API avatar fetch failed");
  }

  if (input.initPhotoUrl) {
    try {
      return await fetchSignedPhotoUrl(input.initPhotoUrl, input.telegramUserId, storageDir);
    } catch {
      console.warn("Telegram initData photo_url avatar fetch failed");
    }
  }

  return null;
}

export async function resolveTelegramUserByUsername(input: {
  botToken: string;
  telegramUsername: string;
  storageDir?: string;
}): Promise<ResolvedTelegramUser | null> {
  const username = input.telegramUsername.trim().replace(/^@/, "");
  if (!username) return null;

  try {
    const chat = await telegramApi<TelegramChat>(input.botToken, "getChat", { chat_id: `@${username}` });
    if (!chat || chat.type !== "private") return null;

    const telegramUserId = String(chat.id);
    const displayName = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim() || chat.username || null;
    const storageDir = input.storageDir ?? defaultAvatarStorageDir();
    const avatarUrl = chat.photo
      ? await downloadTelegramFile(input.botToken, telegramUserId, storageDir, chat.photo.big_file_id, chat.photo.big_file_unique_id)
      : await resolveTelegramAvatarUrl({ botToken: input.botToken, telegramUserId, storageDir });

    return {
      telegramUserId,
      displayName,
      avatarUrl,
    };
  } catch {
    console.warn("Telegram username resolve failed");
    return null;
  }
}

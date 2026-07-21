import { getEnv } from "@/lib/env";
import { findAvatarSourceByStudentId } from "@/lib/store";

type TelegramPhotoSize = {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
};

export async function GET(_request: Request, context: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await context.params;
  const source = await findAvatarSourceByStudentId(studentId);
  if (!source) return new Response(null, { status: 404 });

  if (source.avatarUrl?.startsWith("https://")) {
    return Response.redirect(source.avatarUrl, 302);
  }

  const botToken = getEnv("BOT_TOKEN");
  if (!botToken || !source.telegramUserId) return new Response(null, { status: 404 });

  const photosResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${encodeURIComponent(source.telegramUserId)}&limit=1`,
  );
  const photos = await photosResponse.json().catch(() => null) as TelegramApiResponse<{
    photos?: TelegramPhotoSize[][];
  }> | null;
  const photo = photos?.ok
    ? photos.result?.photos?.[0]?.slice().sort((left, right) =>
      (right.file_size ?? right.width * right.height) - (left.file_size ?? left.width * left.height),
    )[0]
    : null;
  if (!photo) return new Response(null, { status: 404 });

  const fileResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(photo.file_id)}`);
  const file = await fileResponse.json().catch(() => null) as TelegramApiResponse<{ file_path?: string }> | null;
  if (!file?.ok || !file.result?.file_path) return new Response(null, { status: 404 });

  const imageResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.result.file_path}`);
  if (!imageResponse.ok || !imageResponse.body) return new Response(null, { status: 404 });

  return new Response(imageResponse.body, {
    headers: {
      "content-type": imageResponse.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

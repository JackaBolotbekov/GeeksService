import { jsonError, requireAdmin } from "@/lib/api";
import { exchangeYouTubeRefreshToken, hasYouTubeUploadConfiguration } from "@/lib/youtube-oauth";

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  if (!hasYouTubeUploadConfiguration()) {
    return jsonError(
      "YouTube upload не настроен: добавь YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET и YOUTUBE_REFRESH_TOKEN в env.",
      501,
    );
  }

  try {
    return Response.json(await exchangeYouTubeRefreshToken());
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось обновить YouTube OAuth", 502);
  }
}

import { jsonError, requireAdmin } from "@/lib/api";
import { getEnv } from "@/lib/env";

type PrivacyStatus = "private" | "public" | "unlisted";

type UploadSessionRequest = {
  title?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  privacyStatus?: PrivacyStatus;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleErrorResponse = {
  error?: {
    message?: string;
    errors?: Array<{ message?: string; reason?: string }>;
  } | string;
  error_description?: string;
};

const privacyStatuses = new Set<PrivacyStatus>(["private", "public", "unlisted"]);

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as UploadSessionRequest | null;
  const title = body?.title?.trim();
  const description = body?.description?.trim() ?? "";
  const fileSize = body?.fileSize;
  const mimeType = cleanMimeType(body?.mimeType);
  const privacyStatus = privacyStatuses.has(body?.privacyStatus ?? "unlisted")
    ? (body?.privacyStatus ?? "unlisted")
    : "unlisted";

  if (!title) return jsonError("Название ролика обязательно");
  if (title.length > 100) return jsonError("Название YouTube-видео должно быть до 100 символов");
  if (description.length > 5000) return jsonError("Описание YouTube-видео должно быть до 5000 символов");
  if (!Number.isFinite(fileSize) || !fileSize || fileSize <= 0) return jsonError("Выбери корректный видеофайл");
  if (!mimeType.startsWith("video/") && mimeType !== "application/octet-stream") {
    return jsonError("Можно загружать только видеофайлы");
  }

  const clientId = getEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = getEnv("YOUTUBE_CLIENT_SECRET");
  const refreshToken = getEnv("YOUTUBE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    return jsonError(
      "YouTube upload не настроен: добавь YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET и YOUTUBE_REFRESH_TOKEN в env.",
      501,
    );
  }

  try {
    const token = await exchangeRefreshToken({ clientId, clientSecret, refreshToken });
    const uploadUrl = await createResumableUploadSession({
      accessToken: token.accessToken,
      title,
      description,
      fileSize,
      mimeType,
      privacyStatus,
    });

    return Response.json({
      uploadUrl,
      accessToken: token.accessToken,
      expiresIn: token.expiresIn,
      privacyStatus,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось создать YouTube upload session", 502);
  }
}

function cleanMimeType(value: string | null | undefined): string {
  const cleaned = value?.trim().toLowerCase();
  return cleaned || "application/octet-stream";
}

async function exchangeRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
}: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json().catch(() => null) as TokenResponse | null;
  if (!response.ok || !data?.access_token) {
    throw new Error(`YouTube OAuth: ${data?.error_description ?? data?.error ?? response.statusText}`);
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

async function createResumableUploadSession({
  accessToken,
  title,
  description,
  fileSize,
  mimeType,
  privacyStatus,
}: {
  accessToken: string;
  title: string;
  description: string;
  fileSize: number;
  mimeType: string;
  privacyStatus: PrivacyStatus;
}): Promise<string> {
  const categoryId = getEnv("YOUTUBE_CATEGORY_ID") ?? "27";
  const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(fileSize),
      "X-Upload-Content-Type": mimeType,
    },
    body: JSON.stringify({
      snippet: {
        title,
        description,
        categoryId,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    }),
  });

  if (!response.ok) throw new Error(`YouTube API: ${await readGoogleError(response)}`);
  const uploadUrl = response.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube API не вернул upload URL");
  return uploadUrl;
}

async function readGoogleError(response: Response): Promise<string> {
  const data = await response.json().catch(() => null) as GoogleErrorResponse | null;
  if (typeof data?.error === "string") return data.error;
  return data?.error?.message
    ?? data?.error?.errors?.find((item) => item.message)?.message
    ?? data?.error_description
    ?? response.statusText;
}

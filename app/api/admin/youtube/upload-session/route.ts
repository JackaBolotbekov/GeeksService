import { jsonError, requireAdmin } from "@/lib/api";
import { getEnv } from "@/lib/env";
import {
  ActiveUploadJobError,
  createTeacherUploadJob,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import { exchangeYouTubeRefreshToken, hasYouTubeUploadConfiguration } from "@/lib/youtube-oauth";

type PrivacyStatus = "private" | "public" | "unlisted";

type UploadSessionRequest = {
  title?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  privacyStatus?: PrivacyStatus;
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
  const fileName = body?.fileName?.trim() ?? "";
  const fileSize = body?.fileSize;
  const mimeType = cleanMimeType(body?.mimeType);
  const privacyStatus = privacyStatuses.has(body?.privacyStatus ?? "unlisted")
    ? (body?.privacyStatus ?? "unlisted")
    : "unlisted";

  if (!title) return jsonError("Название ролика обязательно");
  if (!fileName) return jsonError("Не указано имя видеофайла");
  if (title.length > 100) return jsonError("Название YouTube-видео должно быть до 100 символов");
  if (description.length > 5000) return jsonError("Описание YouTube-видео должно быть до 5000 символов");
  if (!Number.isFinite(fileSize) || !fileSize || fileSize <= 0) return jsonError("Выбери корректный видеофайл");
  if (!mimeType.startsWith("video/") && mimeType !== "application/octet-stream") {
    return jsonError("Можно загружать только видеофайлы");
  }

  if (!hasYouTubeUploadConfiguration()) {
    return jsonError(
      "YouTube upload не настроен: добавь YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET и YOUTUBE_REFRESH_TOKEN в env.",
      501,
    );
  }

  let jobId: string | null = null;
  try {
    const job = await createTeacherUploadJob({
      title,
      fileName,
      fileSize,
      uploaderTelegramId: identity.telegramUserId,
    });
    jobId = job.id;
    const token = await exchangeYouTubeRefreshToken();
    const uploadUrl = await createResumableUploadSession({
      accessToken: token.accessToken,
      title,
      description,
      fileSize,
      mimeType,
      privacyStatus,
    });
    await updateTeacherUploadJob(job.id, { phase: "uploading", progress: 0 });

    return Response.json({
      uploadUrl,
      accessToken: token.accessToken,
      expiresIn: token.expiresIn,
      privacyStatus,
      jobId: job.id,
    });
  } catch (error) {
    if (error instanceof ActiveUploadJobError) {
      return Response.json({
        message: error.message,
        job: error.job,
      }, { status: 409 });
    }
    if (jobId) {
      await updateTeacherUploadJob(jobId, {
        phase: "error",
        errorMessage: error instanceof Error ? error.message : "Не удалось создать YouTube upload session",
      }).catch(() => undefined);
    }
    return jsonError(error instanceof Error ? error.message : "Не удалось создать YouTube upload session", 502);
  }
}

function cleanMimeType(value: string | null | undefined): string {
  const cleaned = value?.trim().toLowerCase();
  return cleaned || "application/octet-stream";
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

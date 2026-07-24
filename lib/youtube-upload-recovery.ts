import { nextYouTubeUploadOffset } from "./youtube-resumable";

type YouTubeVideoResponse = {
  id?: string;
  snippet?: {
    title?: string;
  };
};

type OEmbedResponse = {
  title?: string;
  author_name?: string;
  provider_name?: string;
};

export type YouTubeUploadStatus =
  | { completed: true; videoId: string }
  | { completed: false; nextOffset: number };

export async function queryYouTubeUploadSession({
  uploadUrl,
  accessToken,
  fileSize,
}: {
  uploadUrl: string;
  accessToken: string;
  fileSize: number;
}): Promise<YouTubeUploadStatus> {
  assertYouTubeUploadUrl(uploadUrl);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Range": `bytes */${fileSize}`,
    },
  });

  if (response.status === 308) {
    return {
      completed: false,
      nextOffset: nextYouTubeUploadOffset(response.headers.get("Range"), 0),
    };
  }

  if (response.ok) {
    const data = await response.json().catch(() => null) as YouTubeVideoResponse | null;
    const videoId = cleanVideoId(data?.id);
    if (!videoId) throw new Error("YouTube подтвердил загрузку, но не вернул video ID");
    return { completed: true, videoId };
  }

  if (response.status === 404 || response.status === 410) {
    throw new Error("Сессия загрузки YouTube истекла, и её результат уже нельзя восстановить автоматически");
  }
  throw new Error(`YouTube не подтвердил загрузку: HTTP ${response.status}`);
}

export async function verifyYouTubeVideo(videoId: string): Promise<{
  videoId: string;
  videoUrl: string;
  title: string;
  authorName: string | null;
}> {
  const cleanId = requiredVideoId(videoId);
  const videoUrl = `https://www.youtube.com/watch?v=${cleanId}`;
  const response = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
  );
  if (!response.ok) throw new Error("YouTube не подтвердил указанное видео");
  const data = await response.json().catch(() => null) as OEmbedResponse | null;
  if (data?.provider_name !== "YouTube" || !data.title?.trim()) {
    throw new Error("YouTube вернул некорректные сведения о видео");
  }
  return {
    videoId: cleanId,
    videoUrl: `https://youtu.be/${cleanId}`,
    title: data.title.trim(),
    authorName: data.author_name?.trim() || null,
  };
}

function assertYouTubeUploadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/upload/youtube/")) {
    throw new Error("Некорректная resumable-сессия YouTube");
  }
}

function requiredVideoId(value: string): string {
  const cleaned = cleanVideoId(value);
  if (!cleaned) throw new Error("Некорректный YouTube video ID");
  return cleaned;
}

function cleanVideoId(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned && /^[A-Za-z0-9_-]{11}$/.test(cleaned) ? cleaned : null;
}

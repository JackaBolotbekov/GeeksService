import { nextYouTubeUploadOffset } from "./youtube-resumable";

type YouTubeVideoResponse = {
  id?: string;
  snippet?: {
    title?: string;
    tags?: string[];
  };
  status?: {
    uploadStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
  };
};

type YouTubeVideosResponse = {
  items?: YouTubeVideoResponse[];
};

type YouTubeChannelsResponse = {
  items?: Array<{
    contentDetails?: {
      relatedPlaylists?: {
        uploads?: string;
      };
    };
  }>;
};

type YouTubePlaylistItemsResponse = {
  items?: Array<{
    snippet?: {
      title?: string;
      publishedAt?: string;
      resourceId?: {
        videoId?: string;
      };
    };
    contentDetails?: {
      videoId?: string;
      videoPublishedAt?: string;
    };
  }>;
};

type OEmbedResponse = {
  title?: string;
  author_name?: string;
  provider_name?: string;
};

export type YouTubeUploadStatus =
  | { completed: true; videoId: string }
  | { completed: false; nextOffset: number };

export class YouTubeUploadSessionUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Сессия загрузки YouTube уже закрыта");
    this.name = "YouTubeUploadSessionUnavailableError";
    this.status = status;
  }
}

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
    throw new YouTubeUploadSessionUnavailableError(response.status);
  }
  throw new Error(`YouTube не подтвердил загрузку: HTTP ${response.status}`);
}

export async function findRecentlyUploadedVideo({
  accessToken,
  title,
  createdAt,
  jobId,
}: {
  accessToken: string;
  title: string;
  createdAt: string;
  jobId?: string;
}): Promise<{ videoId: string; videoUrl: string; title: string } | null> {
  const channelsResponse = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!channelsResponse.ok) return null;
  const channels = await channelsResponse.json().catch(() => null) as YouTubeChannelsResponse | null;
  const uploadsPlaylistId = channels?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads?.trim();
  if (!uploadsPlaylistId) return null;

  const playlistResponse = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=25&playlistId=${encodeURIComponent(uploadsPlaylistId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!playlistResponse.ok) return null;
  const playlist = await playlistResponse.json().catch(() => null) as YouTubePlaylistItemsResponse | null;
  const createdTime = new Date(createdAt).getTime();
  const earliestTime = Number.isFinite(createdTime) ? createdTime - 15 * 60 * 1000 : Date.now() - 24 * 60 * 60 * 1000;
  const candidates = (playlist?.items ?? [])
    .map((item) => {
      const videoId = cleanVideoId(item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId);
      const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
      const publishedTime = publishedAt ? new Date(publishedAt).getTime() : Number.NaN;
      return {
        videoId,
        title: item.snippet?.title?.trim() ?? "",
        publishedTime,
      };
    })
    .filter((item) => (
      item.videoId
      && item.title === title
      && Number.isFinite(item.publishedTime)
      && item.publishedTime >= earliestTime
    ))
    .sort((left, right) => left.publishedTime - right.publishedTime);

  const candidateIds = candidates
    .map((candidate) => candidate.videoId)
    .filter((videoId): videoId is string => Boolean(videoId));
  if (candidateIds.length === 0) return null;

  const marker = jobId ? youtubeUploadJobTag(jobId) : null;
  if (marker) {
    const videosResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${encodeURIComponent(candidateIds.join(","))}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (videosResponse.ok) {
      const videos = await videosResponse.json().catch(() => null) as YouTubeVideosResponse | null;
      const exact = (videos?.items ?? []).find((video) => (
        cleanVideoId(video.id)
        && video.snippet?.title?.trim() === title
        && video.snippet?.tags?.includes(marker)
        && video.status?.uploadStatus !== "deleted"
        && video.status?.uploadStatus !== "failed"
        && video.status?.uploadStatus !== "rejected"
      ));
      const exactId = cleanVideoId(exact?.id);
      if (exactId) {
        return {
          videoId: exactId,
          videoUrl: `https://youtu.be/${exactId}`,
          title: exact?.snippet?.title?.trim() ?? title,
        };
      }
    }
  }

  const match = candidates[0];
  return match?.videoId
    ? {
      videoId: match.videoId,
      videoUrl: `https://youtu.be/${match.videoId}`,
      title: match.title,
    }
    : null;
}

export function youtubeUploadJobTag(jobId: string): string {
  const cleaned = jobId.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!cleaned) throw new Error("Некорректный ID загрузки YouTube");
  return `geeks-upload-${cleaned}`;
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

export function nextYouTubeUploadOffset(range: string | null, fallback: number): number {
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : fallback;
}

export function isRetriableYouTubeUploadStatus(status: number): boolean {
  return status === 0 || [429, 500, 502, 503, 504].includes(status);
}

const MEBIBYTE = 1024 * 1024;

export const YOUTUBE_UPLOAD_MIN_CHUNK_SIZE = 8 * MEBIBYTE;
export const YOUTUBE_UPLOAD_DEFAULT_CHUNK_SIZE = 32 * MEBIBYTE;
export const YOUTUBE_UPLOAD_MAX_CHUNK_SIZE = 128 * MEBIBYTE;

export function initialYouTubeUploadChunkSize(
  downlinkMbps?: number,
  effectiveType?: string,
): number {
  const connectionType = effectiveType?.toLowerCase();
  if (connectionType === "slow-2g" || connectionType === "2g") {
    return YOUTUBE_UPLOAD_MIN_CHUNK_SIZE;
  }
  if (connectionType === "3g") return 16 * MEBIBYTE;

  if (Number.isFinite(downlinkMbps)) {
    const speed = Number(downlinkMbps);
    if (speed < 2) return YOUTUBE_UPLOAD_MIN_CHUNK_SIZE;
    if (speed < 8) return 16 * MEBIBYTE;
    if (speed < 25) return YOUTUBE_UPLOAD_DEFAULT_CHUNK_SIZE;
    if (speed < 60) return 64 * MEBIBYTE;
    return YOUTUBE_UPLOAD_MAX_CHUNK_SIZE;
  }

  return YOUTUBE_UPLOAD_DEFAULT_CHUNK_SIZE;
}

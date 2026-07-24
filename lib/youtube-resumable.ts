export function nextYouTubeUploadOffset(range: string | null, fallback: number): number {
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : fallback;
}

export function isRetriableYouTubeUploadStatus(status: number): boolean {
  return status === 0 || [429, 500, 502, 503, 504].includes(status);
}

const MEBIBYTE = 1024 * 1024;
const YOUTUBE_CHUNK_ALIGNMENT = 256 * 1024;
const TARGET_CHUNK_DURATION_MS = 20_000;

export const YOUTUBE_UPLOAD_MIN_CHUNK_SIZE = 8 * MEBIBYTE;
export const YOUTUBE_UPLOAD_DEFAULT_CHUNK_SIZE = 32 * MEBIBYTE;
export const YOUTUBE_UPLOAD_MAX_CHUNK_SIZE = 128 * MEBIBYTE;

function alignYouTubeChunkSize(size: number): number {
  const clamped = Math.min(
    YOUTUBE_UPLOAD_MAX_CHUNK_SIZE,
    Math.max(YOUTUBE_UPLOAD_MIN_CHUNK_SIZE, size),
  );
  return Math.floor(clamped / YOUTUBE_CHUNK_ALIGNMENT) * YOUTUBE_CHUNK_ALIGNMENT;
}

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

export function nextAdaptiveYouTubeUploadChunkSize(
  currentSize: number,
  uploadedBytes: number,
  elapsedMs: number,
): number {
  if (uploadedBytes <= 0 || elapsedMs <= 0) return alignYouTubeChunkSize(currentSize);

  const measuredTarget = (uploadedBytes / elapsedMs) * TARGET_CHUNK_DURATION_MS;
  const boundedTarget = Math.min(currentSize * 2, Math.max(currentSize / 2, measuredTarget));
  return alignYouTubeChunkSize(boundedTarget);
}

export function smallerYouTubeUploadChunkSize(currentSize: number): number {
  return alignYouTubeChunkSize(currentSize / 2);
}

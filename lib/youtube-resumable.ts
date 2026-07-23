export function nextYouTubeUploadOffset(range: string | null, fallback: number): number {
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : fallback;
}

export function isRetriableYouTubeUploadStatus(status: number): boolean {
  return status === 0 || [429, 500, 502, 503, 504].includes(status);
}

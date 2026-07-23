import { getEnv } from "./env";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export type YouTubeAccessToken = {
  accessToken: string;
  expiresIn: number;
};

export function hasYouTubeUploadConfiguration(): boolean {
  return Boolean(
    getEnv("YOUTUBE_CLIENT_ID")
    && getEnv("YOUTUBE_CLIENT_SECRET")
    && getEnv("YOUTUBE_REFRESH_TOKEN"),
  );
}

export async function exchangeYouTubeRefreshToken(): Promise<YouTubeAccessToken> {
  const clientId = getEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = getEnv("YOUTUBE_CLIENT_SECRET");
  const refreshToken = getEnv("YOUTUBE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YouTube upload не настроен: добавь YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET и YOUTUBE_REFRESH_TOKEN в env.",
    );
  }

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

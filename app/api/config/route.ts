import { getEnv } from "@/lib/env";

export async function GET() {
  return Response.json({
    telegramConfigured: Boolean(getEnv("BOT_TOKEN")),
  });
}

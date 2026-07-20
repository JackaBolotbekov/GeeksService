import { jsonError, requireAdmin } from "@/lib/api";
import { importStudentsSnapshot } from "@/lib/store";
import type { ScoreCell, StudentStatus } from "@/lib/types";

const railwayLeaderboardUrl = "https://geeks-service-production.up.railway.app/api/leaderboard";

type RailwayStudent = {
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  displayName?: string;
  avatarUrl?: string | null;
  status?: StudentStatus;
  scores?: ScoreCell[];
};

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  try {
    const response = await fetch(railwayLeaderboardUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return jsonError("Старая Railway-база сейчас не отвечает", 502);
    const payload = await response.json() as { students?: RailwayStudent[] };
    const students = (payload.students ?? [])
      .filter((student): student is RailwayStudent & { displayName: string } => Boolean(student.displayName?.trim()))
      .map((student) => ({
        telegramUserId: student.telegramUserId ?? null,
        telegramUsername: student.telegramUsername ?? null,
        displayName: student.displayName,
        avatarUrl: student.avatarUrl ?? null,
        status: student.status ?? "active",
        scores: student.scores ?? [],
      }));

    return Response.json(await importStudentsSnapshot(students, identity.telegramUserId));
  } catch {
    return jsonError("Не удалось синхронизировать старую Railway-базу", 502);
  }
}

import { jsonError, requireAdmin } from "@/lib/api";
import { adminStudentsResponse, setScore } from "@/lib/store";

export async function PUT(
  request: Request,
  context: { params: Promise<{ studentId: string; lessonNumber: string }> },
) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const { studentId, lessonNumber } = await context.params;

  const body = await request.json().catch(() => null) as { score?: number | null } | null;
  if (!body || !("score" in body)) return jsonError("Оценка обязательна");

  try {
    await setScore(studentId, Number(lessonNumber), body.score ?? null, identity.telegramUserId);
    return Response.json(await adminStudentsResponse(identity.telegramUserId));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось поставить оценку");
  }
}

import { jsonError, requireAdmin } from "@/lib/api";
import { ScheduleConflictError } from "@/lib/schedule";
import { transferScheduledLesson } from "@/lib/store";

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    lessonNumber?: number;
    expectedScheduledAt?: string;
  } | null;
  if (!Number.isInteger(body?.lessonNumber) || typeof body?.expectedScheduledAt !== "string") {
    return jsonError("Номер занятия и его текущая дата обязательны");
  }

  try {
    return Response.json(await transferScheduledLesson({
      lessonNumber: body.lessonNumber as number,
      expectedScheduledAt: body.expectedScheduledAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось перенести занятие";
    const conflict = error instanceof ScheduleConflictError || /unique|constraint/i.test(message);
    return jsonError(message, conflict ? 409 : 400);
  }
}

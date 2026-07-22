import { jsonError, requireAdmin } from "@/lib/api";
import { saveLessonSchedule } from "@/lib/store";
import type { LessonScheduleInput } from "@/lib/types";

export async function PUT(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as { lessons?: LessonScheduleInput[] } | null;
  if (!Array.isArray(body?.lessons)) return jsonError("Расписание обязательно");

  try {
    return Response.json(await saveLessonSchedule(body.lessons));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось сохранить расписание");
  }
}

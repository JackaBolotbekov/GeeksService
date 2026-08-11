import { jsonError, requireAdmin } from "@/lib/api";
import { ScheduleConflictError } from "@/lib/schedule";
import { transferScheduledGraduation } from "@/lib/store";

export async function PUT(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    expectedGraduationAt?: string;
    targetGraduationAt?: string;
  } | null;
  if (
    typeof body?.expectedGraduationAt !== "string"
    || typeof body?.targetGraduationAt !== "string"
  ) {
    return jsonError("Текущая и новая дата выпуска обязательны");
  }

  try {
    return Response.json(await transferScheduledGraduation({
      expectedGraduationAt: body.expectedGraduationAt,
      targetGraduationAt: body.targetGraduationAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось перенести выпуск";
    return jsonError(message, error instanceof ScheduleConflictError ? 409 : 400);
  }
}

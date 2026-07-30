import { jsonError, requireAdmin } from "@/lib/api";
import { ScheduleConflictError } from "@/lib/schedule";
import { cancelScheduledLessonTransfer, transferScheduledLesson, updateScheduledLessonTransferReason } from "@/lib/store";

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    lessonNumber?: number;
    expectedScheduledAt?: string;
    targetScheduledAt?: string;
    reason?: string | null;
  } | null;
  if (
    !Number.isInteger(body?.lessonNumber)
    || typeof body?.expectedScheduledAt !== "string"
    || typeof body?.targetScheduledAt !== "string"
    || (body.reason != null && typeof body.reason !== "string")
  ) {
    return jsonError("Номер занятия, текущая дата и новая дата обязательны");
  }

  try {
    return Response.json(await transferScheduledLesson({
      lessonNumber: body.lessonNumber as number,
      expectedScheduledAt: body.expectedScheduledAt,
      targetScheduledAt: body.targetScheduledAt,
      reason: body.reason,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось перенести занятие";
    const conflict = error instanceof ScheduleConflictError || /unique|constraint/i.test(message);
    return jsonError(message, conflict ? 409 : 400);
  }
}

export async function PATCH(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    transferId?: string;
    reason?: string | null;
  } | null;
  if (
    typeof body?.transferId !== "string"
    || (body.reason != null && typeof body.reason !== "string")
  ) {
    return jsonError("Перенос обязателен");
  }

  try {
    return Response.json(await updateScheduledLessonTransferReason({
      transferId: body.transferId,
      reason: body.reason,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось сохранить причину переноса";
    return jsonError(message, 400);
  }
}

export async function DELETE(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    transferId?: string;
    expectedRescheduledAt?: string;
  } | null;
  if (typeof body?.transferId !== "string" || typeof body?.expectedRescheduledAt !== "string") {
    return jsonError("Перенос и его текущая дата обязательны");
  }

  try {
    return Response.json(await cancelScheduledLessonTransfer({
      transferId: body.transferId,
      expectedRescheduledAt: body.expectedRescheduledAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось отменить перенос";
    return jsonError(message, error instanceof ScheduleConflictError ? 409 : 400);
  }
}

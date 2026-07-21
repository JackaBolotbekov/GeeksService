import { cleanNullableText, jsonError, parseTelegramContact, requireAdmin } from "@/lib/api";
import { adminStudentsResponse, deleteStudent, updateStudent } from "@/lib/store";
import type { StudentStatus } from "@/lib/types";

export async function PATCH(request: Request, context: { params: Promise<{ studentId: string }> }) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const { studentId } = await context.params;

  const body = await request.json().catch(() => null) as {
    displayName?: string;
    telegram?: string | null;
    telegramUserId?: string | null;
    telegramUsername?: string | null;
    avatarUrl?: string | null;
    status?: StudentStatus;
  } | null;
  if (!body) return jsonError("Некорректные данные ученика");

  try {
    const telegram = parseTelegramContact(body);
    await updateStudent(studentId, {
      displayName: body.displayName,
      telegramUserId: telegram.telegramUserId,
      telegramUsername: telegram.telegramUsername,
      avatarUrl: cleanNullableText(body.avatarUrl),
      status: body.status,
    }, identity.telegramUserId);
    return Response.json(await adminStudentsResponse(identity.telegramUserId));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось обновить ученика");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ studentId: string }> }) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const { studentId } = await context.params;

  try {
    await deleteStudent(studentId);
    return Response.json(await adminStudentsResponse(identity.telegramUserId));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось удалить ученика");
  }
}

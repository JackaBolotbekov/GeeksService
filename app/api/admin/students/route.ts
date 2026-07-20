import { jsonError, parseTelegramContact, requireAdmin } from "@/lib/api";
import { adminStudentsResponse, createStudent } from "@/lib/store";
import type { StudentStatus } from "@/lib/types";

export async function GET(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  return Response.json(await adminStudentsResponse(identity.telegramUserId));
}

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as {
    displayName?: string;
    telegram?: string | null;
    telegramUserId?: string | null;
    telegramUsername?: string | null;
    status?: StudentStatus;
  } | null;
  if (!body?.displayName) return jsonError("Имя ученика обязательно");

  try {
    const telegram = parseTelegramContact(body);
    await createStudent({
      displayName: body.displayName,
      telegramUserId: telegram.telegramUserId,
      telegramUsername: telegram.telegramUsername,
      status: body.status ?? "active",
    }, identity.telegramUserId);
    return Response.json(await adminStudentsResponse(identity.telegramUserId), { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось добавить ученика");
  }
}

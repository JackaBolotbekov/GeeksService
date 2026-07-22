import { jsonError, requireIdentity } from "@/lib/api";
import { createHomeworkSubmission } from "@/lib/homework";
import { findByTelegramUserId } from "@/lib/store";
import type { HomeworkSubmitResponse } from "@/lib/types";

export async function POST(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  const form = await request.formData().catch(() => null);
  if (!form) return jsonError("Не удалось прочитать форму ДЗ");

  const filePart = form.get("file");
  const file = filePart instanceof File && filePart.size > 0 ? filePart : null;
  const links = formText(form, "links");
  const description = formText(form, "description");
  const extra = formText(form, "extra");

  try {
    const student = await findByTelegramUserId(identity.telegramUserId);
    const submission = await createHomeworkSubmission({
      studentId: student?.id ?? null,
      telegramUserId: identity.telegramUserId,
      studentName: student?.displayName ?? identity.displayName ?? `Telegram ${identity.telegramUserId}`,
      links,
      description,
      extra,
      file,
    });
    const response: HomeworkSubmitResponse = {
      ok: true,
      submissionId: submission.id,
      fileName: submission.fileName,
    };
    return Response.json(response);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось отправить ДЗ", 400);
  }
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

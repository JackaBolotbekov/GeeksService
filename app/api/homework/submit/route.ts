import { jsonError, requireIdentity } from "@/lib/api";
import { createHomeworkSubmission } from "@/lib/homework";
import { lessonHomeworkByNumber } from "@/lib/lesson-homework";
import { findByTelegramUserId, getLessonSchedule } from "@/lib/store";
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
  const lessonNumber = Number(formText(form, "lessonNumber"));

  try {
    const student = await findByTelegramUserId(identity.telegramUserId);
    if (!student || student.status !== "active") {
      return jsonError("ДЗ доступно только активным ученикам группы", 403);
    }
    const schedule = await getLessonSchedule();
    const lesson = schedule.lessons.find((item) => item.lessonNumber === lessonNumber);
    if (!lesson?.isCompleted || !lessonHomeworkByNumber(lessonNumber)) {
      return jsonError("ДЗ к этому занятию пока недоступно", 400);
    }
    const submission = await createHomeworkSubmission({
      studentId: student.id,
      lessonNumber,
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
      lessonNumber,
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

import { requireIdentity } from "@/lib/api";
import { listSubmittedLessonNumbers } from "@/lib/homework";
import { findByTelegramUserId } from "@/lib/store";
import type { MeResponse } from "@/lib/types";

export async function GET(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  const student = await findByTelegramUserId(identity.telegramUserId);
  const response: MeResponse = {
    isAdmin: identity.isAdmin,
    student,
    pending: Boolean(student && student.status === "pending"),
    submittedLessonNumbers: student?.status === "active"
      ? await listSubmittedLessonNumbers(student.id)
      : [],
  };
  return Response.json(response);
}

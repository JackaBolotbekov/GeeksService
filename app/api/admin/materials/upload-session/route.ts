import { jsonError, requireAdmin } from "@/lib/api";
import { createTeacherMaterialUploadSession } from "@/lib/materials";

type MaterialUploadSessionRequest = {
  lessonNumber?: number;
  courseMonth?: number;
  videoId?: string | null;
  videoUrl?: string | null;
  fileName?: string;
  fileType?: string | null;
  fileSize?: number;
};

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as MaterialUploadSessionRequest | null;
  try {
    const session = await createTeacherMaterialUploadSession({
      lessonNumber: Number(body?.lessonNumber),
      courseMonth: Number(body?.courseMonth),
      videoId: body?.videoId,
      videoUrl: body?.videoUrl,
      fileName: body?.fileName ?? "",
      fileType: body?.fileType,
      fileSize: Number(body?.fileSize),
      uploaderTelegramId: identity.telegramUserId,
    });
    return Response.json(session);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось начать загрузку допматериала", 400);
  }
}

import { jsonError, requireAdmin } from "@/lib/api";
import { completeTeacherMaterialUpload } from "@/lib/materials";

type CompleteMaterialUploadRequest = {
  sessionId?: string;
};

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const body = await request.json().catch(() => null) as CompleteMaterialUploadRequest | null;
  const sessionId = body?.sessionId?.trim() ?? "";
  if (!sessionId) return jsonError("Не указана загрузка допматериала");

  try {
    const material = await completeTeacherMaterialUpload(sessionId);
    return Response.json(material);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось завершить загрузку допматериала", 400);
  }
}

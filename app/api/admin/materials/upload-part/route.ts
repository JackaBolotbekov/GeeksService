import { jsonError, requireAdmin } from "@/lib/api";
import { MATERIAL_UPLOAD_PART_SIZE } from "@/lib/material-validation";
import { uploadTeacherMaterialPart } from "@/lib/materials";

export async function PUT(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  const partNumber = Number.parseInt(url.searchParams.get("partNumber") ?? "", 10);
  if (!sessionId) return jsonError("Не указана загрузка допматериала");
  if (!Number.isInteger(partNumber) || partNumber < 1) return jsonError("Некорректный номер части");

  const declaredSize = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredSize) && declaredSize > MATERIAL_UPLOAD_PART_SIZE) {
    return jsonError("Часть допматериала превышает 8 MB", 413);
  }

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MATERIAL_UPLOAD_PART_SIZE) {
      return jsonError("Часть допматериала превышает 8 MB", 413);
    }
    const part = await uploadTeacherMaterialPart(sessionId, partNumber, body);
    return Response.json(part);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось загрузить часть допматериала", 400);
  }
}

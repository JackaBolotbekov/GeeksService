import { jsonError, requireAdmin } from "@/lib/api";
import { createTeacherMaterial } from "@/lib/materials";
import type { TeacherMaterialUploadResponse } from "@/lib/types";

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;

  const form = await request.formData().catch(() => null);
  if (!form) return jsonError("Не удалось прочитать допматериал");

  const filePart = form.get("file");
  const file = filePart instanceof File && filePart.size > 0 ? filePart : null;
  if (!file) return jsonError("Выбери файл допматериала");

  try {
    const material = await createTeacherMaterial({
      lessonNumber: formInteger(form, "lessonNumber"),
      courseMonth: formInteger(form, "courseMonth"),
      videoId: formText(form, "videoId"),
      videoUrl: formText(form, "videoUrl"),
      file,
    });
    const response: TeacherMaterialUploadResponse = {
      ok: true,
      materialId: material.id,
      fileName: material.fileName,
    };
    return Response.json(response);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось сохранить допматериал", 400);
  }
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function formInteger(form: FormData, key: string): number {
  return Number.parseInt(formText(form, key), 10);
}

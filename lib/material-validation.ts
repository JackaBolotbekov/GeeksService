export const MAX_MATERIAL_FILE_SIZE = 50 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "json",
  "markdown",
  "md",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "zip",
]);

export function validateTeacherMaterialFile(file: { name: string; size: number }): string {
  if (!file || file.size <= 0) throw new Error("Выбери файл допматериала");
  if (file.size > MAX_MATERIAL_FILE_SIZE) throw new Error("Допматериал должен быть до 50 MB");

  const originalName = cleanOriginalName(file.name);
  const extension = originalName.includes(".") ? originalName.split(".").pop()?.toLowerCase() ?? "" : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Поддерживаются PPTX, PDF, DOCX, XLSX, ZIP, MD, HTML и изображения");
  }
  return originalName;
}

export function cleanOriginalName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 180);
  return cleaned || "material";
}

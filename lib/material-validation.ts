export const MAX_MATERIAL_FILE_SIZE = 50 * 1024 * 1024;
export const MATERIAL_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

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

export function materialUploadPartCount(fileSize: number): number {
  if (!Number.isInteger(fileSize) || fileSize < 1) return 0;
  return Math.ceil(fileSize / MATERIAL_UPLOAD_PART_SIZE);
}

export function expectedMaterialUploadPartSize(fileSize: number, partNumber: number): number {
  const partCount = materialUploadPartCount(fileSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) return 0;
  const start = (partNumber - 1) * MATERIAL_UPLOAD_PART_SIZE;
  return Math.min(MATERIAL_UPLOAD_PART_SIZE, fileSize - start);
}

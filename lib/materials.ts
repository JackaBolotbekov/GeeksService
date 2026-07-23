import { env } from "cloudflare:workers";
import { validateTeacherMaterialFile } from "./material-validation";

type TeacherMaterialInput = {
  lessonNumber: number;
  courseMonth: number;
  videoId?: string | null;
  videoUrl?: string | null;
  file: File;
};

export type TeacherMaterial = {
  id: string;
  fileName: string;
};

let initPromise: Promise<void> | null = null;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

function materialFiles(): R2Bucket {
  const bucket = (env as unknown as { HOMEWORK_FILES?: R2Bucket }).HOMEWORK_FILES;
  if (!bucket) throw new Error("Файловое хранилище HOMEWORK_FILES не настроено");
  return bucket;
}

export async function ensureTeacherMaterialsDatabase(): Promise<void> {
  initPromise ??= d1().prepare(`
    CREATE TABLE IF NOT EXISTS teacher_materials (
      id TEXT PRIMARY KEY,
      lesson_number INTEGER NOT NULL,
      course_month INTEGER NOT NULL DEFAULT 1,
      video_id TEXT,
      video_url TEXT,
      file_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run().then(() => undefined);
  return initPromise;
}

export async function createTeacherMaterial(input: TeacherMaterialInput): Promise<TeacherMaterial> {
  await ensureTeacherMaterialsDatabase();

  const lessonNumber = assertPositiveInteger(input.lessonNumber, "Номер занятия");
  const courseMonth = assertPositiveInteger(input.courseMonth, "Месяц обучения");
  const file = input.file;
  const originalName = validateTeacherMaterialFile(file);

  const id = crypto.randomUUID();
  const key = `teacher-materials/month-${courseMonth}/lesson-${lessonNumber}/${id}-${safeObjectName(originalName)}`;
  const type = file.type || "application/octet-stream";
  await materialFiles().put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: type },
    customMetadata: {
      originalName,
      lessonNumber: String(lessonNumber),
      courseMonth: String(courseMonth),
      ...(input.videoId ? { videoId: input.videoId } : {}),
    },
  });

  try {
    await d1().prepare(`
      INSERT INTO teacher_materials (
        id,
        lesson_number,
        course_month,
        video_id,
        video_url,
        file_key,
        file_name,
        file_type,
        file_size
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      lessonNumber,
      courseMonth,
      cleanNullable(input.videoId),
      cleanNullable(input.videoUrl),
      key,
      originalName,
      type,
      file.size,
    ).run();
  } catch (error) {
    await materialFiles().delete(key).catch(() => undefined);
    throw error;
  }

  return { id, fileName: originalName };
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} указан некорректно`);
  return value;
}

function safeObjectName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "material";
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

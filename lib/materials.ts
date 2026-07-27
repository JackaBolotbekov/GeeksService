import { env } from "cloudflare:workers";
import {
  expectedMaterialUploadPartSize,
  MATERIAL_UPLOAD_PART_SIZE,
  materialUploadPartCount,
  validateTeacherMaterialFile,
} from "./material-validation";
import type {
  TeacherMaterialUploadPartResponse,
  TeacherMaterialUploadResponse,
  TeacherMaterialUploadSessionResponse,
} from "./types";

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

type TeacherMaterialUploadSessionInput = {
  lessonNumber: number;
  courseMonth: number;
  videoId?: string | null;
  videoUrl?: string | null;
  fileName: string;
  fileType?: string | null;
  fileSize: number;
  uploaderTelegramId: string;
};

type MaterialUploadSessionRow = {
  id: string;
  upload_id: string;
  file_key: string;
  file_name: string;
  file_type: string;
  file_size: number;
  part_size: number;
  lesson_number: number;
  course_month: number;
  video_id: string | null;
  video_url: string | null;
  uploader_telegram_id: string;
  status: string;
  material_id: string | null;
  created_at: string;
  updated_at: string;
};

type MaterialUploadPartRow = {
  part_number: number;
  etag: string;
  part_size: number;
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
  initPromise ??= (async () => {
    await d1().prepare(`
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
    `).run();
    await d1().prepare(`
      CREATE TABLE IF NOT EXISTS teacher_material_upload_sessions (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL,
        file_key TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        part_size INTEGER NOT NULL,
        lesson_number INTEGER NOT NULL,
        course_month INTEGER NOT NULL DEFAULT 1,
        video_id TEXT,
        video_url TEXT,
        uploader_telegram_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploading',
        material_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await d1().prepare(`
      CREATE TABLE IF NOT EXISTS teacher_material_upload_parts (
        session_id TEXT NOT NULL REFERENCES teacher_material_upload_sessions(id) ON DELETE CASCADE,
        part_number INTEGER NOT NULL,
        etag TEXT NOT NULL,
        part_size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, part_number)
      )
    `).run();
    await d1().prepare(`
      CREATE INDEX IF NOT EXISTS teacher_material_upload_sessions_lookup_idx
      ON teacher_material_upload_sessions(
        uploader_telegram_id,
        course_month,
        lesson_number,
        file_name,
        file_size,
        created_at
      )
    `).run();
  })();
  return initPromise;
}

export async function createTeacherMaterialUploadSession(
  input: TeacherMaterialUploadSessionInput,
): Promise<TeacherMaterialUploadSessionResponse> {
  await ensureTeacherMaterialsDatabase();

  const lessonNumber = assertPositiveInteger(input.lessonNumber, "Номер занятия");
  const courseMonth = assertPositiveInteger(input.courseMonth, "Месяц обучения");
  const fileName = validateTeacherMaterialFile({ name: input.fileName, size: input.fileSize });
  const fileType = input.fileType?.trim() || "application/octet-stream";
  const videoId = cleanNullable(input.videoId);
  const videoUrl = cleanNullable(input.videoUrl);
  const uploaderTelegramId = input.uploaderTelegramId.trim();
  if (!uploaderTelegramId) throw new Error("Не указан преподаватель");

  const reusable = await d1().prepare(`
    SELECT *
    FROM teacher_material_upload_sessions
    WHERE uploader_telegram_id = ?
      AND course_month = ?
      AND lesson_number = ?
      AND file_name = ?
      AND file_size = ?
      AND COALESCE(video_id, '') = ?
      AND status IN ('uploading', 'completed')
      AND created_at >= datetime('now', '-24 hours')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(
    uploaderTelegramId,
    courseMonth,
    lessonNumber,
    fileName,
    input.fileSize,
    videoId ?? "",
  ).first<MaterialUploadSessionRow>();
  if (reusable) return materialUploadSessionResponse(reusable);

  const id = crypto.randomUUID();
  const key = `teacher-materials/month-${courseMonth}/lesson-${lessonNumber}/${id}-${safeObjectName(fileName)}`;
  const upload = await materialFiles().createMultipartUpload(key, {
    httpMetadata: { contentType: fileType },
    customMetadata: {
      originalName: fileName,
      lessonNumber: String(lessonNumber),
      courseMonth: String(courseMonth),
      ...(videoId ? { videoId } : {}),
    },
  });
  const now = new Date().toISOString();
  try {
    await d1().prepare(`
      INSERT INTO teacher_material_upload_sessions (
        id,
        upload_id,
        file_key,
        file_name,
        file_type,
        file_size,
        part_size,
        lesson_number,
        course_month,
        video_id,
        video_url,
        uploader_telegram_id,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)
    `).bind(
      id,
      upload.uploadId,
      key,
      fileName,
      fileType,
      input.fileSize,
      MATERIAL_UPLOAD_PART_SIZE,
      lessonNumber,
      courseMonth,
      videoId,
      videoUrl,
      uploaderTelegramId,
      now,
      now,
    ).run();
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }

  const created = await materialUploadSessionRow(id);
  if (!created) throw new Error("Не удалось создать загрузку допматериала");
  return materialUploadSessionResponse(created);
}

export async function uploadTeacherMaterialPart(
  sessionId: string,
  partNumber: number,
  body: ArrayBuffer,
): Promise<TeacherMaterialUploadPartResponse> {
  await ensureTeacherMaterialsDatabase();
  const session = await materialUploadSessionRow(sessionId);
  if (!session) throw new Error("Загрузка допматериала не найдена");
  if (session.status === "completed") throw new Error("Допматериал уже сохранён");
  if (session.status !== "uploading") throw new Error("Загрузка допматериала недоступна");

  const expectedSize = expectedMaterialUploadPartSize(session.file_size, partNumber);
  if (!expectedSize || body.byteLength !== expectedSize) {
    throw new Error("Размер части допматериала не совпадает");
  }

  const upload = materialFiles().resumeMultipartUpload(session.file_key, session.upload_id);
  const part = await upload.uploadPart(partNumber, body);
  await d1().prepare(`
    INSERT INTO teacher_material_upload_parts (
      session_id,
      part_number,
      etag,
      part_size,
      created_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, part_number) DO UPDATE SET
      etag = excluded.etag,
      part_size = excluded.part_size,
      created_at = excluded.created_at
  `).bind(
    session.id,
    part.partNumber,
    part.etag,
    body.byteLength,
    new Date().toISOString(),
  ).run();
  await touchMaterialUploadSession(session.id);
  return { ok: true, partNumber: part.partNumber, size: body.byteLength };
}

export async function completeTeacherMaterialUpload(
  sessionId: string,
): Promise<TeacherMaterialUploadResponse> {
  await ensureTeacherMaterialsDatabase();
  const session = await materialUploadSessionRow(sessionId);
  if (!session) throw new Error("Загрузка допматериала не найдена");
  if (session.status === "completed" && session.material_id) {
    return { ok: true, materialId: session.material_id, fileName: session.file_name };
  }
  if (session.status !== "uploading") throw new Error("Загрузка допматериала недоступна");

  const parts = await materialUploadParts(session.id);
  const expectedCount = materialUploadPartCount(session.file_size);
  if (parts.length !== expectedCount) throw new Error("Не все части допматериала загружены");
  for (const part of parts) {
    const expectedSize = expectedMaterialUploadPartSize(session.file_size, part.part_number);
    if (part.part_size !== expectedSize) throw new Error("Одна из частей допматериала повреждена");
  }

  const bucket = materialFiles();
  let object = await bucket.head(session.file_key);
  if (!object) {
    const upload = bucket.resumeMultipartUpload(session.file_key, session.upload_id);
    try {
      await upload.complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    } catch (error) {
      object = await bucket.head(session.file_key);
      if (!object) throw error;
    }
  }

  const materialId = session.id;
  const now = new Date().toISOString();
  await d1().batch([
    d1().prepare(`
      INSERT INTO teacher_materials (
        id,
        lesson_number,
        course_month,
        video_id,
        video_url,
        file_key,
        file_name,
        file_type,
        file_size,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      materialId,
      session.lesson_number,
      session.course_month,
      session.video_id,
      session.video_url,
      session.file_key,
      session.file_name,
      session.file_type,
      session.file_size,
      now,
    ),
    d1().prepare(`
      UPDATE teacher_material_upload_sessions
      SET status = 'completed', material_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(materialId, now, session.id),
  ]);

  return { ok: true, materialId, fileName: session.file_name };
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
  await materialFiles().put(key, file.stream(), {
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

async function materialUploadSessionRow(id: string): Promise<MaterialUploadSessionRow | null> {
  return d1().prepare(`
    SELECT * FROM teacher_material_upload_sessions WHERE id = ? LIMIT 1
  `).bind(id).first<MaterialUploadSessionRow>();
}

async function materialUploadParts(sessionId: string): Promise<MaterialUploadPartRow[]> {
  const rows = await d1().prepare(`
    SELECT part_number, etag, part_size
    FROM teacher_material_upload_parts
    WHERE session_id = ?
    ORDER BY part_number ASC
  `).bind(sessionId).all<MaterialUploadPartRow>();
  return rows.results;
}

async function materialUploadSessionResponse(
  row: MaterialUploadSessionRow,
): Promise<TeacherMaterialUploadSessionResponse> {
  const parts = await materialUploadParts(row.id);
  return {
    sessionId: row.id,
    fileName: row.file_name,
    fileSize: row.file_size,
    partSize: row.part_size,
    completed: row.status === "completed",
    materialId: row.material_id,
    uploadedParts: parts.map((part) => ({ partNumber: part.part_number, size: part.part_size })),
  };
}

async function touchMaterialUploadSession(id: string): Promise<void> {
  await d1().prepare(`
    UPDATE teacher_material_upload_sessions SET updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();
}

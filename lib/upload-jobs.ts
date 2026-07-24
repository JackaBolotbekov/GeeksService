import { env } from "cloudflare:workers";
import type { TeacherUploadJob, TeacherUploadJobPhase } from "./types";

type UploadJobRow = {
  id: string;
  title: string;
  file_name: string;
  file_size: number;
  lesson_number: number;
  course_month: number;
  upload_url: string | null;
  progress: number;
  phase: string;
  video_id: string | null;
  video_url: string | null;
  error_message: string | null;
  uploader_telegram_id: string;
  created_at: string;
  updated_at: string;
};

type CreateUploadJobInput = {
  title: string;
  fileName: string;
  fileSize: number;
  lessonNumber: number;
  courseMonth: number;
  uploaderTelegramId: string;
};

type UpdateUploadJobInput = {
  progress?: number;
  phase?: Exclude<TeacherUploadJobPhase, "interrupted">;
  videoId?: string | null;
  videoUrl?: string | null;
  errorMessage?: string | null;
  uploadUrl?: string | null;
  lessonNumber?: number;
  courseMonth?: number;
};

export type TeacherUploadJobInternal = TeacherUploadJob & {
  uploadUrl: string | null;
  createdAt: string;
};

const activePhases = ["creating", "uploading", "saving"] as const;
const staleAfterMs = 45_000;
let initPromise: Promise<void> | null = null;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

export class ActiveUploadJobError extends Error {
  constructor(public readonly job: TeacherUploadJob) {
    super("Другое видео уже загружается");
  }
}

export async function ensureTeacherUploadJobsDatabase(): Promise<void> {
  initPromise ??= d1().prepare(`
    CREATE TABLE IF NOT EXISTS teacher_upload_jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      lesson_number INTEGER NOT NULL DEFAULT 1,
      course_month INTEGER NOT NULL DEFAULT 1,
      upload_url TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'creating',
      video_id TEXT,
      video_url TEXT,
      error_message TEXT,
      uploader_telegram_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run().then(() => undefined);
  return initPromise;
}

export async function createTeacherUploadJob(input: CreateUploadJobInput): Promise<TeacherUploadJob> {
  await ensureTeacherUploadJobsDatabase();
  const active = await activeUploadJobRow();
  if (active) throw new ActiveUploadJobError(toUploadJob(active));

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await d1().prepare(`
    INSERT INTO teacher_upload_jobs (
      id,
      title,
      file_name,
      file_size,
      lesson_number,
      course_month,
      progress,
      phase,
      uploader_telegram_id,
      created_at,
      updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 0, 'creating', ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM teacher_upload_jobs
      WHERE phase IN ('creating', 'uploading', 'saving')
    )
  `).bind(
    id,
    input.title.slice(0, 100),
    input.fileName.slice(0, 240),
    input.fileSize,
    positiveInteger(input.lessonNumber, 1),
    positiveInteger(input.courseMonth, 1),
    input.uploaderTelegramId,
    now,
    now,
  ).run();

  const created = await uploadJobRow(id);
  if (!created) {
    const conflicting = await activeUploadJobRow();
    if (conflicting) throw new ActiveUploadJobError(toUploadJob(conflicting));
    throw new Error("Не удалось создать состояние загрузки");
  }
  return toUploadJob(created);
}

export async function currentTeacherUploadJob(): Promise<TeacherUploadJob | null> {
  await ensureTeacherUploadJobsDatabase();
  const row = await activeUploadJobRow();
  return row ? toUploadJob(row) : null;
}

export async function teacherUploadJobInternal(id: string): Promise<TeacherUploadJobInternal | null> {
  await ensureTeacherUploadJobsDatabase();
  const row = await uploadJobRow(id);
  return row ? toInternalUploadJob(row) : null;
}

export async function latestRecoverableTeacherUploadJob(title: string): Promise<TeacherUploadJob | null> {
  await ensureTeacherUploadJobsDatabase();
  const row = await d1().prepare(`
    SELECT *
    FROM teacher_upload_jobs
    WHERE title = ? AND phase IN ('creating', 'uploading', 'saving', 'error')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(title.slice(0, 100)).first<UploadJobRow>();
  return row ? toUploadJob(row) : null;
}

export async function updateTeacherUploadJob(
  id: string,
  input: UpdateUploadJobInput,
): Promise<TeacherUploadJob | null> {
  await ensureTeacherUploadJobsDatabase();
  const current = await uploadJobRow(id);
  if (!current || current.phase === "cancelled") return null;

  const progress = input.progress === undefined
    ? current.progress
    : Math.max(current.progress, Math.max(0, Math.min(100, Math.round(input.progress))));
  const phase = input.phase ?? current.phase;
  const videoId = input.videoId === undefined ? current.video_id : cleanNullable(input.videoId);
  const videoUrl = input.videoUrl === undefined ? current.video_url : cleanNullable(input.videoUrl);
  const errorMessage = input.errorMessage === undefined
    ? current.error_message
    : cleanNullable(input.errorMessage)?.slice(0, 500) ?? null;
  const uploadUrl = input.uploadUrl === undefined ? current.upload_url : cleanNullable(input.uploadUrl);
  const lessonNumber = input.lessonNumber === undefined
    ? positiveInteger(current.lesson_number, 1)
    : positiveInteger(input.lessonNumber, 1);
  const courseMonth = input.courseMonth === undefined
    ? positiveInteger(current.course_month, 1)
    : positiveInteger(input.courseMonth, 1);
  const now = new Date().toISOString();

  await d1().prepare(`
    UPDATE teacher_upload_jobs
    SET progress = ?, phase = ?, video_id = ?, video_url = ?, error_message = ?,
        upload_url = ?, lesson_number = ?, course_month = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    progress,
    phase,
    videoId,
    videoUrl,
    errorMessage,
    uploadUrl,
    lessonNumber,
    courseMonth,
    now,
    id,
  ).run();

  const updated = await uploadJobRow(id);
  return updated ? toUploadJob(updated) : null;
}

export async function cancelTeacherUploadJob(id: string): Promise<void> {
  await ensureTeacherUploadJobsDatabase();
  await d1().prepare(`
    UPDATE teacher_upload_jobs
    SET phase = 'cancelled', updated_at = ?
    WHERE id = ? AND phase IN ('creating', 'uploading', 'saving')
  `).bind(new Date().toISOString(), id).run();
}

async function activeUploadJobRow(): Promise<UploadJobRow | null> {
  const placeholders = activePhases.map(() => "?").join(", ");
  return d1().prepare(`
    SELECT *
    FROM teacher_upload_jobs
    WHERE phase IN (${placeholders})
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(...activePhases).first<UploadJobRow>();
}

async function uploadJobRow(id: string): Promise<UploadJobRow | null> {
  return d1().prepare("SELECT * FROM teacher_upload_jobs WHERE id = ? LIMIT 1")
    .bind(id)
    .first<UploadJobRow>();
}

function toUploadJob(row: UploadJobRow): TeacherUploadJob {
  const updatedAt = parseSqlDate(row.updated_at);
  const isStale = activePhases.includes(row.phase as (typeof activePhases)[number])
    && Date.now() - updatedAt.getTime() > staleAfterMs;
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    fileSize: row.file_size,
    lessonNumber: positiveInteger(row.lesson_number, 1),
    courseMonth: positiveInteger(row.course_month, 1),
    progress: row.progress,
    phase: isStale ? "interrupted" : phaseOf(row.phase),
    videoId: row.video_id,
    videoUrl: row.video_url,
    errorMessage: row.error_message,
    updatedAt: updatedAt.toISOString(),
    isStale,
  };
}

function toInternalUploadJob(row: UploadJobRow): TeacherUploadJobInternal {
  return {
    ...toUploadJob(row),
    uploadUrl: row.upload_url,
    createdAt: parseSqlDate(row.created_at).toISOString(),
  };
}

function phaseOf(value: string): Exclude<TeacherUploadJobPhase, "interrupted"> {
  return ["creating", "uploading", "saving", "done", "error", "cancelled"].includes(value)
    ? value as Exclude<TeacherUploadJobPhase, "interrupted">
    : "error";
}

function parseSqlDate(value: string): Date {
  const isoValue = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(isoValue);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function cleanNullable(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

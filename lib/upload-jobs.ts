import { env } from "cloudflare:workers";
import type {
  TeacherUploadChunkDiagnostic,
  TeacherUploadJob,
  TeacherUploadJobPhase,
} from "./types";

type UploadJobRow = {
  id: string;
  title: string;
  file_name: string;
  file_size: number;
  lesson_number: number;
  course_month: number;
  upload_url: string | null;
  confirmed_offset: number;
  chunk_size: number | null;
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
  confirmedOffset?: number;
  chunkSize?: number | null;
  lessonNumber?: number;
  courseMonth?: number;
  allowResume?: boolean;
};

export type UploadChunkDiagnosticInput = Omit<
  TeacherUploadChunkDiagnostic,
  "id" | "jobId" | "createdAt"
>;

export type TeacherUploadJobInternal = TeacherUploadJob & {
  uploadUrl: string | null;
  createdAt: string;
};

const activePhases = ["creating", "uploading", "paused", "saving"] as const;
const heartbeatPhases = ["creating", "uploading", "saving"] as const;
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
  initPromise ??= (async () => {
    await d1().prepare(`
      CREATE TABLE IF NOT EXISTS teacher_upload_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        lesson_number INTEGER NOT NULL DEFAULT 1,
        course_month INTEGER NOT NULL DEFAULT 1,
        upload_url TEXT,
        confirmed_offset INTEGER NOT NULL DEFAULT 0,
        chunk_size INTEGER,
        progress INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'creating',
        video_id TEXT,
        video_url TEXT,
        error_message TEXT,
        uploader_telegram_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await addColumnIfMissing(
      "ALTER TABLE teacher_upload_jobs ADD COLUMN confirmed_offset INTEGER NOT NULL DEFAULT 0",
    );
    await addColumnIfMissing(
      "ALTER TABLE teacher_upload_jobs ADD COLUMN chunk_size INTEGER",
    );
    await d1().prepare(`
      CREATE TABLE IF NOT EXISTS teacher_upload_chunk_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES teacher_upload_jobs(id) ON DELETE CASCADE,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        confirmed_offset INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        speed_bps INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        http_status INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await d1().prepare(`
      CREATE INDEX IF NOT EXISTS teacher_upload_chunk_events_job_created_idx
      ON teacher_upload_chunk_events(job_id, created_at)
    `).run();
  })();
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
      WHERE phase IN ('creating', 'uploading', 'paused', 'saving')
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

export async function teacherUploadJob(id: string): Promise<TeacherUploadJob | null> {
  await ensureTeacherUploadJobsDatabase();
  const row = await uploadJobRow(id);
  return row ? toUploadJob(row) : null;
}

export async function latestRecoverableTeacherUploadJob(title: string): Promise<TeacherUploadJob | null> {
  await ensureTeacherUploadJobsDatabase();
  const row = await d1().prepare(`
    SELECT *
    FROM teacher_upload_jobs
    WHERE title = ? AND phase IN ('creating', 'uploading', 'paused', 'saving', 'error')
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

  const requestedProgress = input.progress === undefined
    ? current.progress
    : Math.max(0, Math.min(100, Math.round(input.progress)));
  const progress = input.phase === "paused" || input.allowResume
    ? requestedProgress
    : Math.max(current.progress, requestedProgress);
  const requestedPhase = input.phase ?? current.phase;
  const phase = current.phase === "paused"
    && requestedPhase === "uploading"
    && !input.allowResume
    ? "paused"
    : current.phase === "done" && requestedPhase !== "done"
      ? "done"
      : requestedPhase;
  const videoId = input.videoId === undefined ? current.video_id : cleanNullable(input.videoId);
  const videoUrl = input.videoUrl === undefined ? current.video_url : cleanNullable(input.videoUrl);
  const errorMessage = input.errorMessage === undefined
    ? current.error_message
    : cleanNullable(input.errorMessage)?.slice(0, 500) ?? null;
  const uploadUrl = input.uploadUrl === undefined ? current.upload_url : cleanNullable(input.uploadUrl);
  const confirmedOffset = input.confirmedOffset === undefined
    ? current.confirmed_offset
    : Math.max(current.confirmed_offset, boundedInteger(input.confirmedOffset, 0, current.file_size));
  const chunkSize = input.chunkSize === undefined
    ? current.chunk_size
    : input.chunkSize === null
      ? null
      : boundedInteger(input.chunkSize, 1, current.file_size);
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
        upload_url = ?, confirmed_offset = ?, chunk_size = ?,
        lesson_number = ?, course_month = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    progress,
    phase,
    videoId,
    videoUrl,
    errorMessage,
    uploadUrl,
    confirmedOffset,
    chunkSize,
    lessonNumber,
    courseMonth,
    now,
    id,
  ).run();

  const updated = await uploadJobRow(id);
  return updated ? toUploadJob(updated) : null;
}

export async function recordTeacherUploadChunkDiagnostic(
  jobId: string,
  input: UploadChunkDiagnosticInput,
): Promise<void> {
  await ensureTeacherUploadJobsDatabase();
  const job = await uploadJobRow(jobId);
  if (!job) return;
  const startOffset = boundedInteger(input.startOffset, 0, job.file_size);
  const endOffset = boundedInteger(input.endOffset, startOffset, job.file_size);
  const confirmedOffset = boundedInteger(input.confirmedOffset, 0, job.file_size);
  const chunkSize = boundedInteger(input.chunkSize, 1, job.file_size);
  const outcome = ["confirmed", "completed", "retry", "status"].includes(input.outcome)
    ? input.outcome
    : "retry";
  await d1().prepare(`
    INSERT INTO teacher_upload_chunk_events (
      id, job_id, start_offset, end_offset, confirmed_offset, chunk_size,
      elapsed_ms, speed_bps, retry_count, http_status, outcome, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    jobId,
    startOffset,
    endOffset,
    confirmedOffset,
    chunkSize,
    boundedInteger(input.elapsedMs, 0, 86_400_000),
    boundedInteger(input.speedBps, 0, Number.MAX_SAFE_INTEGER),
    boundedInteger(input.retryCount, 0, 100),
    boundedInteger(input.httpStatus, 0, 999),
    outcome,
    new Date().toISOString(),
  ).run();
}

export async function listTeacherUploadChunkDiagnostics(
  jobId: string,
  limit = 120,
): Promise<TeacherUploadChunkDiagnostic[]> {
  await ensureTeacherUploadJobsDatabase();
  const rows = await d1().prepare(`
    SELECT *
    FROM teacher_upload_chunk_events
    WHERE job_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(jobId, boundedInteger(limit, 1, 500)).all<{
    id: string;
    job_id: string;
    start_offset: number;
    end_offset: number;
    confirmed_offset: number;
    chunk_size: number;
    elapsed_ms: number;
    speed_bps: number;
    retry_count: number;
    http_status: number;
    outcome: string;
    created_at: string;
  }>();
  return rows.results.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    confirmedOffset: row.confirmed_offset,
    chunkSize: row.chunk_size,
    elapsedMs: row.elapsed_ms,
    speedBps: row.speed_bps,
    retryCount: row.retry_count,
    httpStatus: row.http_status,
    outcome: diagnosticOutcome(row.outcome),
    createdAt: parseSqlDate(row.created_at).toISOString(),
  }));
}

export async function cancelTeacherUploadJob(id: string): Promise<void> {
  await ensureTeacherUploadJobsDatabase();
  await d1().prepare(`
    UPDATE teacher_upload_jobs
    SET phase = 'cancelled', updated_at = ?
    WHERE id = ? AND phase IN ('creating', 'uploading', 'paused', 'saving')
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
  const isStale = heartbeatPhases.includes(row.phase as (typeof heartbeatPhases)[number])
    && Date.now() - updatedAt.getTime() > staleAfterMs;
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    fileSize: row.file_size,
    lessonNumber: positiveInteger(row.lesson_number, 1),
    courseMonth: positiveInteger(row.course_month, 1),
    confirmedOffset: Math.max(0, Math.min(row.file_size, Number(row.confirmed_offset) || 0)),
    chunkSize: row.chunk_size && row.chunk_size > 0 ? row.chunk_size : null,
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
  return ["creating", "uploading", "paused", "saving", "done", "error", "cancelled"].includes(value)
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

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

async function addColumnIfMissing(statement: string): Promise<void> {
  try {
    await d1().prepare(statement).run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
}

function diagnosticOutcome(value: string): TeacherUploadChunkDiagnostic["outcome"] {
  return ["confirmed", "completed", "retry", "status"].includes(value)
    ? value as TeacherUploadChunkDiagnostic["outcome"]
    : "retry";
}

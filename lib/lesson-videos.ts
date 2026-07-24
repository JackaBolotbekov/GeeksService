import { env } from "cloudflare:workers";
import type { TeacherLessonVideo } from "./types";

type LessonVideoRow = {
  id: string;
  lesson_number: number;
  course_month: number;
  video_id: string;
  video_url: string;
  title: string;
  verified_at: string;
  created_at: string;
  updated_at: string;
};

type UpsertLessonVideoInput = {
  lessonNumber: number;
  courseMonth: number;
  videoId: string;
  videoUrl?: string;
  title: string;
  verifiedAt?: string;
};

let initPromise: Promise<void> | null = null;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

export async function ensureTeacherLessonVideosDatabase(): Promise<void> {
  initPromise ??= d1().prepare(`
    CREATE TABLE IF NOT EXISTS teacher_lesson_videos (
      id TEXT PRIMARY KEY,
      lesson_number INTEGER NOT NULL,
      course_month INTEGER NOT NULL DEFAULT 1,
      video_id TEXT NOT NULL UNIQUE,
      video_url TEXT NOT NULL,
      title TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(course_month, lesson_number)
    )
  `).run().then(() => undefined);
  return initPromise;
}

export async function upsertTeacherLessonVideo(input: UpsertLessonVideoInput): Promise<TeacherLessonVideo> {
  await ensureTeacherLessonVideosDatabase();
  const lessonNumber = positiveInteger(input.lessonNumber, "Номер занятия");
  const courseMonth = positiveInteger(input.courseMonth, "Месяц обучения");
  const videoId = cleanVideoId(input.videoId);
  const title = input.title.trim().slice(0, 100);
  if (!title) throw new Error("Название видео не указано");
  const videoUrl = input.videoUrl?.trim() || `https://youtu.be/${videoId}`;
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const now = new Date().toISOString();
  const existing = await d1().prepare(`
    SELECT id
    FROM teacher_lesson_videos
    WHERE course_month = ? AND lesson_number = ?
    LIMIT 1
  `).bind(courseMonth, lessonNumber).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();

  await d1().batch([
    d1().prepare(`
      DELETE FROM teacher_lesson_videos
      WHERE video_id = ? AND NOT (course_month = ? AND lesson_number = ?)
    `).bind(videoId, courseMonth, lessonNumber),
    d1().prepare(`
      INSERT INTO teacher_lesson_videos (
        id, lesson_number, course_month, video_id, video_url, title, verified_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(course_month, lesson_number) DO UPDATE SET
        video_id = excluded.video_id,
        video_url = excluded.video_url,
        title = excluded.title,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `).bind(
      id,
      lessonNumber,
      courseMonth,
      videoId,
      videoUrl.slice(0, 500),
      title,
      verifiedAt,
      now,
      now,
    ),
  ]);

  const row = await d1().prepare(`
    SELECT *
    FROM teacher_lesson_videos
    WHERE course_month = ? AND lesson_number = ?
    LIMIT 1
  `).bind(courseMonth, lessonNumber).first<LessonVideoRow>();
  if (!row) throw new Error("Не удалось закрепить видео за занятием");
  return toLessonVideo(row);
}

export async function teacherLessonVideo(
  lessonNumber: number,
  courseMonth: number,
): Promise<TeacherLessonVideo | null> {
  await ensureTeacherLessonVideosDatabase();
  const row = await d1().prepare(`
    SELECT *
    FROM teacher_lesson_videos
    WHERE course_month = ? AND lesson_number = ?
    LIMIT 1
  `).bind(
    positiveInteger(courseMonth, "Месяц обучения"),
    positiveInteger(lessonNumber, "Номер занятия"),
  ).first<LessonVideoRow>();
  return row ? toLessonVideo(row) : null;
}

function toLessonVideo(row: LessonVideoRow): TeacherLessonVideo {
  return {
    id: row.id,
    lessonNumber: row.lesson_number,
    courseMonth: row.course_month,
    videoId: row.video_id,
    videoUrl: row.video_url,
    title: row.title,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} указан некорректно`);
  return value;
}

function cleanVideoId(value: string): string {
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(cleaned)) throw new Error("Некорректный YouTube video ID");
  return cleaned;
}

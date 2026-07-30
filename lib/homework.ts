import { env } from "cloudflare:workers";

type HomeworkSubmissionInput = {
  studentId: string;
  lessonNumber: number;
  telegramUserId: string;
  studentName: string;
  links: string;
  description: string;
  extra: string;
  file?: File | null;
};

export type HomeworkSubmission = {
  id: string;
  fileName: string | null;
};

const MAX_TEXT_LENGTH = 5000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

let initPromise: Promise<void> | null = null;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

function homeworkFiles(): R2Bucket | null {
  return (env as unknown as { HOMEWORK_FILES?: R2Bucket }).HOMEWORK_FILES ?? null;
}

export async function ensureHomeworkDatabase(): Promise<void> {
  initPromise ??= initializeHomeworkDatabase();
  return initPromise;
}

async function initializeHomeworkDatabase(): Promise<void> {
  await d1().prepare(`
    CREATE TABLE IF NOT EXISTS homework_submissions (
      id TEXT PRIMARY KEY,
      student_id TEXT,
      lesson_number INTEGER,
      telegram_user_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      links TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      extra TEXT NOT NULL DEFAULT '',
      file_key TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE SET NULL
    )
  `).run();
  const columns = await d1().prepare("PRAGMA table_info(homework_submissions)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "lesson_number")) {
    await d1().prepare("ALTER TABLE homework_submissions ADD COLUMN lesson_number INTEGER").run();
  }
  await d1().prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS homework_submissions_student_lesson_unique
    ON homework_submissions(student_id, lesson_number)
    WHERE student_id IS NOT NULL AND lesson_number IS NOT NULL
  `).run();
}

export async function createHomeworkSubmission(input: HomeworkSubmissionInput): Promise<HomeworkSubmission> {
  await ensureHomeworkDatabase();

  if (!Number.isInteger(input.lessonNumber) || input.lessonNumber < 1 || input.lessonNumber > 12) {
    throw new Error("Некорректный номер занятия");
  }

  const existing = await d1().prepare(`
    SELECT id FROM homework_submissions
    WHERE student_id = ? AND lesson_number = ?
    LIMIT 1
  `).bind(input.studentId, input.lessonNumber).first<{ id: string }>();
  if (existing) throw new Error("ДЗ к этому занятию уже отправлено");

  const links = cleanLinks(input.links);
  const description = cleanText(input.description, "Описание");
  const extra = cleanText(input.extra, "Дополнение");
  const file = input.file && input.file.size > 0 ? input.file : null;
  if (!links && !description && !extra && !file) {
    throw new Error("Добавь ссылку, описание или файл домашки");
  }

  const fileMeta = file ? await saveHomeworkFile(file, input.telegramUserId) : null;
  const id = crypto.randomUUID();
  await d1().prepare(`
    INSERT INTO homework_submissions (
      id,
      student_id,
      lesson_number,
      telegram_user_id,
      student_name,
      links,
      description,
      extra,
      file_key,
      file_name,
      file_type,
      file_size
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.studentId,
    input.lessonNumber,
    input.telegramUserId,
    cleanStudentName(input.studentName),
    links,
    description,
    extra,
    fileMeta?.key ?? null,
    fileMeta?.name ?? null,
    fileMeta?.type ?? null,
    fileMeta?.size ?? null,
  ).run();

  return {
    id,
    fileName: fileMeta?.name ?? null,
  };
}

export async function listSubmittedLessonNumbers(studentId: string): Promise<number[]> {
  await ensureHomeworkDatabase();
  const rows = await d1().prepare(`
    SELECT lesson_number AS lessonNumber
    FROM homework_submissions
    WHERE student_id = ? AND lesson_number BETWEEN 1 AND 12
    ORDER BY lesson_number
  `).bind(studentId).all<{ lessonNumber: number }>();
  return rows.results.map((row) => row.lessonNumber);
}

function cleanText(value: string, label: string): string {
  const cleaned = value.trim();
  if (cleaned.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label}: максимум ${MAX_TEXT_LENGTH} символов`);
  }
  return cleaned;
}

function cleanLinks(value: string): string {
  const cleaned = cleanText(value, "Ссылки");
  if (!cleaned) return "";
  const invalid = cleaned
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((token) => !isLinkToken(token));
  if (invalid) {
    throw new Error("В ссылках оставь URL, сайт или @username. Лучше по одной строке.");
  }
  return cleaned;
}

function isLinkToken(token: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(token)
    || /^@[a-z0-9_]{3,32}$/i.test(token)
    || /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(token);
}

function cleanStudentName(value: string): string {
  const cleaned = value.trim();
  return cleaned || "Ученик";
}

async function saveHomeworkFile(file: File, telegramUserId: string): Promise<{
  key: string;
  name: string;
  type: string;
  size: number;
}> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("Файл домашки должен быть до 50 MB");
  }

  const bucket = homeworkFiles();
  if (!bucket) {
    throw new Error("Файловое хранилище HOMEWORK_FILES не настроено");
  }

  const safeName = safeFileName(file.name || "homework-file");
  const key = `homework/${telegramUserId}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type || "application/octet-stream",
    },
    customMetadata: {
      originalName: safeName,
      telegramUserId,
    },
  });

  return {
    key,
    name: safeName,
    type: file.type || "application/octet-stream",
    size: file.size,
  };
}

function safeFileName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "homework-file";
}

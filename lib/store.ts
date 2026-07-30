import { env } from "cloudflare:workers";
import { buildScheduleResponse, DEFAULT_LESSON_SCHEDULE, normalizeLessonSchedule, restoreLessonTransferSchedule, transferLessonSchedule as calculateLessonTransfer } from "./schedule";
import { normalizeTelegramUsername, publicTelegramAvatar } from "./telegram";
import { LESSON_COUNT, type AdminStudentsResponse, type LessonScheduleInput, type LessonScheduleTransfer, type ScheduleResponse, type ScoreCell, type StudentStatus, type StudentView } from "./types";

type StudentRow = {
  id: string;
  telegram_user_id: string | null;
  telegram_username: string | null;
  display_name: string;
  avatar_url: string | null;
  status: string;
};

type ScoreRow = {
  student_id: string;
  lesson_number: number;
  score: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type LessonScheduleRow = {
  lesson_number: number;
  scheduled_at: string;
  course_month: number;
  updated_at: string | null;
};

type LessonScheduleTransferRow = {
  id: string;
  lesson_number: number;
  original_scheduled_at: string;
  rescheduled_at: string;
  reason: string | null;
  before_schedule_json: string | null;
  cancelled_at: string | null;
  created_at: string;
};

type CreateStudentInput = {
  displayName: string;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  avatarUrl?: string | null;
  status?: StudentStatus;
};

type PatchStudentInput = Partial<CreateStudentInput>;

type ImportedStudent = {
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  displayName: string;
  avatarUrl?: string | null;
  status?: StudentStatus;
  scores?: ScoreCell[];
};

const seedStudents: CreateStudentInput[] = [
  { displayName: "Абдрахман Талайбеков", telegramUsername: "shoro_senpai" },
  { displayName: "Абдыкул Нурэл", telegramUsername: "mishka_freddy288" },
  { displayName: "Акыл Мухамбетов", telegramUsername: "akyl1230" },
  { displayName: "Алихан Муратов" },
  { displayName: "Байэл Кочкорбаев", telegramUsername: "dedd101" },
  { displayName: "Камила Эркинова", telegramUsername: "ghiogo" },
  { displayName: "Мирас Орозов", telegramUsername: "orozov_4" },
  { displayName: "Мырзабек Джаныбеков" },
  { displayName: "Нурсултан Кубанычбеков", telegramUsername: "nurs_10" },
  { displayName: "Чынтемир Мухамбетов", telegramUsername: "chinaronaldo" },
];

let initPromise: Promise<void> | null = null;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

export async function ensureDatabase(): Promise<void> {
  initPromise ??= initializeDatabase();
  return initPromise;
}

async function initializeDatabase(): Promise<void> {
  const db = d1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        telegram_user_id TEXT UNIQUE,
        telegram_username TEXT UNIQUE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS lesson_scores (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        lesson_number INTEGER NOT NULL,
        score INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, lesson_number),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS lesson_schedule (
        id TEXT PRIMARY KEY,
        lesson_number INTEGER NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        course_month INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS lesson_schedule_transfers (
        id TEXT PRIMARY KEY,
        lesson_number INTEGER NOT NULL,
        original_scheduled_at TEXT NOT NULL,
        rescheduled_at TEXT NOT NULL,
        reason TEXT,
        before_schedule_json TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(lesson_number, original_scheduled_at)
      )
    `),
  ]);
  await ensureTransferHistoryColumns(db);

  await seedLessonScheduleIfEmpty(db);
  await seedExistingLessonTransferIfEmpty(db);

  const existing = await db.prepare("SELECT COUNT(*) AS count FROM students").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;

  for (const student of seedStudents) {
    const telegramUsername = normalizeTelegramUsername(student.telegramUsername);
    await db.prepare(`
      INSERT INTO students (id, telegram_user_id, telegram_username, display_name, avatar_url, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      assertTelegramId(student.telegramUserId),
      telegramUsername,
      assertName(student.displayName),
      student.avatarUrl ?? publicTelegramAvatar(telegramUsername),
      student.status ?? "active",
    ).run();
  }
}

async function ensureTransferHistoryColumns(db: D1Database): Promise<void> {
  const result = await db.prepare("PRAGMA table_info(lesson_schedule_transfers)").all<{ name: string }>();
  const columns = new Set((result.results ?? []).map((column) => column.name));
  if (!columns.has("before_schedule_json")) {
    await db.prepare("ALTER TABLE lesson_schedule_transfers ADD COLUMN before_schedule_json TEXT").run();
  }
  if (!columns.has("cancelled_at")) {
    await db.prepare("ALTER TABLE lesson_schedule_transfers ADD COLUMN cancelled_at TEXT").run();
  }
  if (!columns.has("reason")) {
    await db.prepare("ALTER TABLE lesson_schedule_transfers ADD COLUMN reason TEXT").run();
  }
}

async function seedLessonScheduleIfEmpty(db: D1Database): Promise<void> {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM lesson_schedule").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;
  await db.batch(DEFAULT_LESSON_SCHEDULE.map((lesson) =>
    db.prepare(`
      INSERT INTO lesson_schedule (id, lesson_number, scheduled_at, course_month)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), lesson.lessonNumber, lesson.scheduledAt, lesson.courseMonth ?? 1),
  ));
}

async function seedExistingLessonTransferIfEmpty(db: D1Database): Promise<void> {
  const existing = await db.prepare("SELECT COUNT(*) AS count FROM lesson_schedule_transfers").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;
  const lesson = await db.prepare("SELECT scheduled_at FROM lesson_schedule WHERE lesson_number = 6").first<{ scheduled_at: string }>();
  if (lesson?.scheduled_at !== "2026-07-20T16:00:00+06:00") return;
  await db.prepare(`
    INSERT OR IGNORE INTO lesson_schedule_transfers (
      id, lesson_number, original_scheduled_at, rescheduled_at, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    "seed-transfer-2026-07-17",
    6,
    "2026-07-17T16:00:00+06:00",
    "2026-07-20T16:00:00+06:00",
    "2026-07-17T16:00:00+06:00",
  ).run();
}

function statusOf(value: string): StudentStatus {
  return value === "pending" || value === "archived" ? value : "active";
}

function transferRow(row: LessonScheduleTransferRow): LessonScheduleTransfer {
  return {
    id: row.id,
    lessonNumber: row.lesson_number,
    originalScheduledAt: row.original_scheduled_at,
    rescheduledAt: row.rescheduled_at,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function emptyScores(): ScoreCell[] {
  return Array.from({ length: LESSON_COUNT }, (_, index) => ({ lessonNumber: index + 1, score: null, updatedAt: null }));
}

function assertName(displayName: string): string {
  const value = displayName.trim();
  if (value.length < 2 || value.length > 60) throw new Error("Имя должно быть от 2 до 60 символов");
  return value;
}

function assertTelegramId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{1,20}$/.test(trimmed)) throw new Error("Telegram ID должен быть числом");
  return trimmed;
}

function assertScore(score: number | null): number | null {
  if (score === null) return null;
  if (!Number.isInteger(score) || score < 1 || score > 10) throw new Error("Оценка должна быть от 1 до 10");
  return score;
}

function assertLessonNumber(lessonNumber: number): number {
  if (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > LESSON_COUNT) {
    throw new Error(`Занятие должно быть от 1 до ${LESSON_COUNT}`);
  }
  return lessonNumber;
}

function rowToStudent(row: StudentRow, scores: ScoreCell[], currentTelegramUserId: string | null): StudentView {
  const completedLessons = scores.filter((cell) => cell.score !== null).length;
  const totalScore = scores.reduce((sum, cell) => sum + (cell.score ?? 0), 0);
  const lastScoredAt = scores.reduce<string | null>((latest, cell) => {
    if (cell.score === null || !cell.updatedAt) return latest;
    return !latest || cell.updatedAt > latest ? cell.updatedAt : latest;
  }, null);
  const avatarUrl = row.avatar_url
    ?? publicTelegramAvatar(row.telegram_username)
    ?? (row.telegram_user_id ? `/api/avatar/${row.id}` : null);
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
    displayName: row.display_name,
    avatarUrl,
    status: statusOf(row.status),
    scores,
    completedLessons,
    totalScore,
    lastScoredAt,
    place: null,
    pointsBehindLeader: 0,
    isCurrentUser: Boolean(currentTelegramUserId && row.telegram_user_id === currentTelegramUserId),
  };
}

function withRanking(students: StudentView[]): StudentView[] {
  const active = students
    .filter((student) => student.status === "active")
    .sort((left, right) =>
      right.totalScore - left.totalScore
      || compareScoreTime(left.lastScoredAt, right.lastScoredAt)
      || right.completedLessons - left.completedLessons
      || left.displayName.localeCompare(right.displayName, "ru"),
    );
  const leaderScore = active[0]?.totalScore ?? 0;
  const places = new Map(active.map((student, index) => [student.id, index + 1]));
  return students.map((student) => ({
    ...student,
    place: places.get(student.id) ?? null,
    pointsBehindLeader: student.status === "active" ? Math.max(0, leaderScore - student.totalScore) : 0,
  }));
}

function compareScoreTime(left: string | null, right: string | null): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

export async function listStudents(currentTelegramUserId: string | null = null): Promise<StudentView[]> {
  await ensureDatabase();
  const db = d1();
  const studentsResult = await db.prepare("SELECT * FROM students").all<StudentRow>();
  const scoreResult = await db.prepare("SELECT student_id, lesson_number, score, created_at, updated_at FROM lesson_scores").all<ScoreRow>();
  const scoresByStudent = new Map<string, ScoreCell[]>();
  for (const row of scoreResult.results ?? []) {
    const scores = scoresByStudent.get(row.student_id) ?? emptyScores();
    scores[row.lesson_number - 1] = { lessonNumber: row.lesson_number, score: row.score, updatedAt: row.updated_at ?? row.created_at };
    scoresByStudent.set(row.student_id, scores);
  }

  const views = (studentsResult.results ?? []).map((row) =>
    rowToStudent(row, scoresByStudent.get(row.id) ?? emptyScores(), currentTelegramUserId),
  );
  return withRanking(views)
    .filter((student) => student.status === "active")
    .sort((left, right) => (left.place ?? 999) - (right.place ?? 999) || left.displayName.localeCompare(right.displayName, "ru"));
}

export async function getLessonSchedule(now = new Date()): Promise<ScheduleResponse> {
  await ensureDatabase();
  const db = d1();
  const [result, transferResult] = await Promise.all([
    db.prepare(`
      SELECT lesson_number, scheduled_at, course_month, updated_at
      FROM lesson_schedule
      ORDER BY lesson_number ASC
    `).all<LessonScheduleRow>(),
    db.prepare(`
      SELECT id, lesson_number, original_scheduled_at, rescheduled_at, reason,
             before_schedule_json, cancelled_at, created_at
      FROM lesson_schedule_transfers
      WHERE cancelled_at IS NULL
      ORDER BY created_at ASC
    `).all<LessonScheduleTransferRow>(),
  ]);
  const rows = result.results ?? [];
  const source = rows.length === LESSON_COUNT
    ? rows.map((row) => ({
      lessonNumber: row.lesson_number,
      scheduledAt: row.scheduled_at,
      courseMonth: row.course_month,
      updatedAt: row.updated_at,
    }))
    : DEFAULT_LESSON_SCHEDULE;
  return buildScheduleResponse(source, now, (transferResult.results ?? []).map(transferRow));
}

export async function saveLessonSchedule(input: LessonScheduleInput[], now = new Date()): Promise<ScheduleResponse> {
  await ensureDatabase();
  const db = d1();
  const lessons = normalizeLessonSchedule(input);
  const updatedAt = new Date().toISOString();
  await db.batch(lessons.map((lesson) =>
    db.prepare(`
      INSERT INTO lesson_schedule (id, lesson_number, scheduled_at, course_month, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lesson_number)
      DO UPDATE SET scheduled_at = excluded.scheduled_at,
                    course_month = excluded.course_month,
                    updated_at = excluded.updated_at
    `).bind(crypto.randomUUID(), lesson.lessonNumber, lesson.scheduledAt, lesson.courseMonth, updatedAt),
  ));
  return getLessonSchedule(now);
}

export async function transferScheduledLesson(
  input: { lessonNumber: number; expectedScheduledAt: string; targetScheduledAt: string; reason?: string | null },
  now = new Date(),
): Promise<ScheduleResponse> {
  await ensureDatabase();
  const db = d1();
  const result = await db.prepare(`
    SELECT lesson_number, scheduled_at, course_month, updated_at
    FROM lesson_schedule
    ORDER BY lesson_number ASC
  `).all<LessonScheduleRow>();
  const source = (result.results ?? []).map((row) => ({
    lessonNumber: row.lesson_number,
    scheduledAt: row.scheduled_at,
    courseMonth: row.course_month,
    updatedAt: row.updated_at,
  }));
  const calculated = calc
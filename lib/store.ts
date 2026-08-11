import { env } from "cloudflare:workers";
import { listTeacherLessonVideos } from "./lesson-videos";
import { buildScheduleResponse, DEFAULT_GRADUATION_AT, DEFAULT_LESSON_SCHEDULE, normalizeLessonSchedule, restoreLessonTransferSchedule, transferGraduationSchedule as calculateGraduationTransfer, transferLessonSchedule as calculateLessonTransfer } from "./schedule";
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

type CourseScheduleSettingsRow = {
  graduation_at: string;
  updated_at: string | null;
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
    db.prepare(`
      CREATE TABLE IF NOT EXISTS course_schedule_settings (
        id TEXT PRIMARY KEY,
        graduation_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);
  await ensureTransferHistoryColumns(db);

  await seedLessonScheduleIfEmpty(db);
  await seedExistingLessonTransferIfEmpty(db);
  await seedCourseScheduleSettingsIfEmpty(db);

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
  const [result, transferResult, courseSettings, lessonVideos] = await Promise.all([
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
    db.prepare(`
      SELECT graduation_at, updated_at
      FROM course_schedule_settings
      WHERE id = 'graduation'
    `).first<CourseScheduleSettingsRow>(),
    listTeacherLessonVideos(),
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
  return buildScheduleResponse(
    source,
    now,
    (transferResult.results ?? []).map(transferRow),
    lessonVideos,
    courseSettings?.graduation_at ?? DEFAULT_GRADUATION_AT,
  );
}

async function seedCourseScheduleSettingsIfEmpty(db: D1Database): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO course_schedule_settings (id, graduation_at)
    VALUES ('graduation', ?)
  `).bind(DEFAULT_GRADUATION_AT).run();
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
  const calculated = calculateLessonTransfer(
    source,
    input.lessonNumber,
    input.expectedScheduledAt,
    input.targetScheduledAt,
    now,
  );
  const updatedAt = now.toISOString();
  const transferId = crypto.randomUUID();
  const beforeScheduleJson = JSON.stringify(source.map((lesson) => ({
    lessonNumber: lesson.lessonNumber,
    scheduledAt: lesson.scheduledAt,
    courseMonth: lesson.courseMonth,
  })));
  const selectedIndex = calculated.lessons.findIndex((lesson) => lesson.lessonNumber === input.lessonNumber);
  const statements = calculated.lessons.slice(selectedIndex).map((lesson) =>
    db.prepare(`
      UPDATE lesson_schedule
      SET scheduled_at = ?, course_month = ?, updated_at = ?
      WHERE lesson_number = ?
    `).bind(lesson.scheduledAt, lesson.courseMonth, updatedAt, lesson.lessonNumber),
  );
  statements.push(db.prepare(`
    INSERT INTO lesson_schedule_transfers (
      id, lesson_number, original_scheduled_at, rescheduled_at,
      reason, before_schedule_json, cancelled_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(lesson_number, original_scheduled_at)
    DO UPDATE SET id = excluded.id,
                  rescheduled_at = excluded.rescheduled_at,
                  reason = excluded.reason,
                  before_schedule_json = excluded.before_schedule_json,
                  cancelled_at = NULL,
                  created_at = excluded.created_at
  `).bind(
    transferId,
    calculated.transfer.lessonNumber,
    calculated.transfer.originalScheduledAt,
    calculated.transfer.rescheduledAt,
    normalizeTransferReason(input.reason),
    beforeScheduleJson,
    calculated.transfer.createdAt,
  ));
  await db.batch(statements);
  return getLessonSchedule(now);
}

export async function transferScheduledGraduation(
  input: { expectedGraduationAt: string; targetGraduationAt: string },
  now = new Date(),
): Promise<ScheduleResponse> {
  await ensureDatabase();
  const db = d1();
  const [courseSettings, lessonResult] = await Promise.all([
    db.prepare(`
      SELECT graduation_at, updated_at
      FROM course_schedule_settings
      WHERE id = 'graduation'
    `).first<CourseScheduleSettingsRow>(),
    db.prepare(`
      SELECT lesson_number, scheduled_at, course_month, updated_at
      FROM lesson_schedule
      ORDER BY lesson_number ASC
    `).all<LessonScheduleRow>(),
  ]);
  const currentGraduationAt = courseSettings?.graduation_at ?? DEFAULT_GRADUATION_AT;
  const lessons = (lessonResult.results ?? []).map((row) => ({
    lessonNumber: row.lesson_number,
    scheduledAt: row.scheduled_at,
    courseMonth: row.course_month,
    updatedAt: row.updated_at,
  }));
  const targetGraduationAt = calculateGraduationTransfer(
    currentGraduationAt,
    input.expectedGraduationAt,
    input.targetGraduationAt,
    lessons,
    now,
  );
  const result = await db.prepare(`
    UPDATE course_schedule_settings
    SET graduation_at = ?, updated_at = ?
    WHERE id = 'graduation' AND graduation_at = ?
  `).bind(targetGraduationAt, now.toISOString(), input.expectedGraduationAt).run();
  if ((result.meta?.changes ?? 0) < 1) {
    throw new ScheduleConflictError("Дата выпуска уже изменилась. Обнови календарь и попробуй снова");
  }
  return getLessonSchedule(now);
}

export async function cancelScheduledLessonTransfer(
  input: { transferId: string; expectedRescheduledAt: string },
  now = new Date(),
): Promise<ScheduleResponse> {
  await ensureDatabase();
  const db = d1();
  const latest = await db.prepare(`
    SELECT id, lesson_number, original_scheduled_at, rescheduled_at, reason,
           before_schedule_json, cancelled_at, created_at
    FROM lesson_schedule_transfers
    WHERE cancelled_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).first<LessonScheduleTransferRow>();
  if (!latest || latest.id !== input.transferId) {
    throw new ScheduleConflictError("Отменить можно только последний активный перенос");
  }
  if (latest.rescheduled_at !== input.expectedRescheduledAt) {
    throw new ScheduleConflictError("Расписание уже изменилось. Обнови календарь и попробуй снова");
  }
  if (new Date(latest.original_scheduled_at).getTime() <= now.getTime()) {
    throw new Error("Исходное занятие уже началось, перенос отменить нельзя");
  }

  let restored: LessonScheduleInput[];
  if (latest.before_schedule_json) {
    const parsed = JSON.parse(latest.before_schedule_json) as LessonScheduleInput[];
    restored = normalizeLessonSchedule(parsed);
  } else {
    const currentResult = await db.prepare(`
      SELECT lesson_number, scheduled_at, course_month, updated_at
      FROM lesson_schedule
      ORDER BY lesson_number ASC
    `).all<LessonScheduleRow>();
    const current = (currentResult.results ?? []).map((row) => ({
      lessonNumber: row.lesson_number,
      scheduledAt: row.scheduled_at,
      courseMonth: row.course_month,
      updatedAt: row.updated_at,
    }));
    const selected = current.find((lesson) => lesson.lessonNumber === latest.lesson_number);
    if (!selected || selected.scheduledAt !== latest.rescheduled_at) {
      throw new ScheduleConflictError("Расписание уже изменилось. Обнови календарь и попробуй снова");
    }
    restored = restoreLessonTransferSchedule(
      current,
      latest.lesson_number,
      latest.original_scheduled_at,
    );
  }
  const updatedAt = now.toISOString();
  const statements = restored.map((lesson) =>
    db.prepare(`
      UPDATE lesson_schedule
      SET scheduled_at = ?, course_month = ?, updated_at = ?
      WHERE lesson_number = ?
    `).bind(lesson.scheduledAt, lesson.courseMonth, updatedAt, lesson.lessonNumber),
  );
  statements.push(db.prepare(`
    UPDATE lesson_schedule_transfers
    SET cancelled_at = ?
    WHERE id = ? AND cancelled_at IS NULL
  `).bind(updatedAt, latest.id));
  await db.batch(statements);
  return getLessonSchedule(now);
}

export async function updateScheduledLessonTransferReason(
  input: { transferId: string; reason?: string | null },
  now = new Date(),
): Promise<ScheduleResponse> {
  await ensureDatabase();
  const result = await d1().prepare(`
    UPDATE lesson_schedule_transfers
    SET reason = ?
    WHERE id = ? AND cancelled_at IS NULL
  `).bind(normalizeTransferReason(input.reason), input.transferId).run();
  if ((result.meta?.changes ?? 0) < 1) {
    throw new Error("Перенос не найден");
  }
  return getLessonSchedule(now);
}

function normalizeTransferReason(value?: string | null): string | null {
  const reason = String(value ?? "").trim();
  if (!reason) return null;
  if (reason.length > 300) throw new Error("Причина переноса должна быть короче 300 символов");
  return reason;
}

export async function adminStudentsResponse(currentTelegramUserId: string | null): Promise<AdminStudentsResponse> {
  await ensureDatabase();
  const all = await listAllStudents(currentTelegramUserId);
  return {
    students: all
      .filter((student) => student.status !== "pending")
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === "active" ? -1 : 1;
        return (left.place ?? 999) - (right.place ?? 999) || left.displayName.localeCompare(right.displayName, "ru");
      }),
    pendingStudents: all
      .filter((student) => student.status === "pending")
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "ru")),
  };
}

async function listAllStudents(currentTelegramUserId: string | null): Promise<StudentView[]> {
  const db = d1();
  const studentsResult = await db.prepare("SELECT * FROM students").all<StudentRow>();
  const scoreResult = await db.prepare("SELECT student_id, lesson_number, score, created_at, updated_at FROM lesson_scores").all<ScoreRow>();
  const scoresByStudent = new Map<string, ScoreCell[]>();
  for (const row of scoreResult.results ?? []) {
    const scores = scoresByStudent.get(row.student_id) ?? emptyScores();
    scores[row.lesson_number - 1] = { lessonNumber: row.lesson_number, score: row.score, updatedAt: row.updated_at ?? row.created_at };
    scoresByStudent.set(row.student_id, scores);
  }
  return withRanking((studentsResult.results ?? []).map((row) =>
    rowToStudent(row, scoresByStudent.get(row.id) ?? emptyScores(), currentTelegramUserId),
  ));
}

export async function findByTelegramUserId(telegramUserId: string): Promise<StudentView | null> {
  await ensureDatabase();
  const db = d1();
  const row = await db.prepare("SELECT * FROM students WHERE telegram_user_id = ?").bind(telegramUserId).first<StudentRow>();
  if (!row) return null;
  return (await listAllStudents(telegramUserId)).find((student) => student.id === row.id) ?? null;
}

export async function findAvatarSourceByStudentId(studentId: string): Promise<{
  telegramUserId: string | null;
  telegramUsername: string | null;
  avatarUrl: string | null;
} | null> {
  await ensureDatabase();
  const db = d1();
  const row = await db.prepare(`
    SELECT telegram_user_id, telegram_username, avatar_url
    FROM students
    WHERE id = ?
  `).bind(studentId).first<Pick<StudentRow, "telegram_user_id" | "telegram_username" | "avatar_url">>();
  if (!row) return null;
  return {
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
    avatarUrl: row.avatar_url,
  };
}

export async function upsertTelegramStudent(input: {
  telegramUserId: string;
  telegramUsername?: string | null;
  displayName: string;
  avatarUrl?: string | null;
}): Promise<StudentView> {
  await ensureDatabase();
  const db = d1();
  const telegramUsername = normalizeTelegramUsername(input.telegramUsername);
  const existingById = await db.prepare("SELECT * FROM students WHERE telegram_user_id = ?").bind(input.telegramUserId).first<StudentRow>();
  const avatarUrl = input.avatarUrl ?? publicTelegramAvatar(telegramUsername);

  if (existingById) {
    if (telegramUsername) {
      await db.prepare("UPDATE students SET telegram_username = NULL WHERE telegram_username = ? AND id <> ?")
        .bind(telegramUsername, existingById.id)
        .run();
    }
    await db.prepare(`
      UPDATE students
      SET telegram_username = ?, avatar_url = COALESCE(?, avatar_url), last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(telegramUsername, avatarUrl, existingById.id).run();
    return (await listAllStudents(input.telegramUserId)).find((student) => student.id === existingById.id) as StudentView;
  }

  const existingByUsername = telegramUsername
    ? await db.prepare("SELECT * FROM students WHERE telegram_username = ?").bind(telegramUsername).first<StudentRow>()
    : null;

  if (existingByUsername && !existingByUsername.telegram_user_id) {
    await db.prepare(`
      UPDATE students
      SET telegram_user_id = ?, avatar_url = COALESCE(?, avatar_url), last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(input.telegramUserId, avatarUrl, existingByUsername.id).run();
    return (await listAllStudents(input.telegramUserId)).find((student) => student.id === existingByUsername.id) as StudentView;
  }

  return createStudent({
    displayName: input.displayName,
    telegramUserId: input.telegramUserId,
    telegramUsername,
    avatarUrl,
    status: "pending",
  }, input.telegramUserId);
}

export async function createStudent(input: CreateStudentInput, currentTelegramUserId: string | null = null): Promise<StudentView> {
  await ensureDatabase();
  const db = d1();
  const displayName = assertName(input.displayName);
  const telegramUserId = assertTelegramId(input.telegramUserId);
  const telegramUsername = normalizeTelegramUsername(input.telegramUsername);
  const status = input.status ?? "active";
  const avatarUrl = input.avatarUrl ?? publicTelegramAvatar(telegramUsername);
  const existingByName = await db.prepare(`
    SELECT * FROM students
    WHERE lower(display_name) = lower(?) AND telegram_user_id IS NULL AND telegram_username IS NULL
    LIMIT 1
  `).bind(displayName).first<StudentRow>();

  if (existingByName && (telegramUserId || telegramUsername)) {
    return updateStudent(existingByName.id, { telegramUserId, telegramUsername, status }, currentTelegramUserId);
  }

  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO students (id, telegram_user_id, telegram_username, display_name, avatar_url, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, telegramUserId, telegramUsername, displayName, avatarUrl, status).run();
  return (await listAllStudents(currentTelegramUserId)).find((student) => student.id === id) as StudentView;
}

export async function importStudentsSnapshot(input: ImportedStudent[], currentTelegramUserId: string | null): Promise<AdminStudentsResponse> {
  await ensureDatabase();
  const db = d1();

  for (const student of input) {
    const displayName = assertName(student.displayName);
    const telegramUserId = assertTelegramId(student.telegramUserId);
    const telegramUsername = normalizeTelegramUsername(student.telegramUsername);
    const avatarUrl = cleanImportedAvatar(student.avatarUrl, telegramUsername);
    const status = student.status ?? "active";
    const existing = await findImportMatch(db, displayName, telegramUserId, telegramUsername);
    let studentId = existing?.id;

    if (studentId) {
      await db.prepare(`
        UPDATE students
        SET telegram_user_id = COALESCE(?, telegram_user_id),
            telegram_username = COALESCE(?, telegram_username),
            display_name = ?,
            avatar_url = COALESCE(?, avatar_url),
            status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(telegramUserId, telegramUsername, displayName, avatarUrl, status, studentId).run();
    } else {
      studentId = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO students (id, telegram_user_id, telegram_username, display_name, avatar_url, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(studentId, telegramUserId, telegramUsername, displayName, avatarUrl, status).run();
    }

    for (const cell of student.scores ?? []) {
      if (cell.score === null) continue;
      await setScore(studentId, cell.lessonNumber, cell.score);
    }
  }

  return adminStudentsResponse(currentTelegramUserId);
}

async function findImportMatch(
  db: D1Database,
  displayName: string,
  telegramUserId: string | null,
  telegramUsername: string | null,
): Promise<StudentRow | null> {
  if (telegramUserId) {
    const byId = await db.prepare("SELECT * FROM students WHERE telegram_user_id = ?").bind(telegramUserId).first<StudentRow>();
    if (byId) return byId;
  }
  if (telegramUsername) {
    const byUsername = await db.prepare("SELECT * FROM students WHERE telegram_username = ?").bind(telegramUsername).first<StudentRow>();
    if (byUsername) return byUsername;
  }
  return await db.prepare("SELECT * FROM students WHERE lower(display_name) = lower(?) LIMIT 1").bind(displayName).first<StudentRow>();
}

function cleanImportedAvatar(avatarUrl: string | null | undefined, telegramUsername: string | null): string | null {
  const publicAvatar = publicTelegramAvatar(telegramUsername);
  if (publicAvatar) return publicAvatar;
  if (!avatarUrl) return null;
  return avatarUrl.startsWith("https://") ? avatarUrl : null;
}

export async function updateStudent(id: string, input: PatchStudentInput, currentTelegramUserId: string | null = null): Promise<StudentView> {
  await ensureDatabase();
  const db = d1();
  const existing = await db.prepare("SELECT * FROM students WHERE id = ?").bind(id).first<StudentRow>();
  if (!existing) throw new Error("Ученик не найден");

  const displayName = input.displayName === undefined ? existing.display_name : assertName(input.displayName);
  const telegramUserId = input.telegramUserId === undefined ? existing.telegram_user_id : assertTelegramId(input.telegramUserId);
  const telegramUsername = input.telegramUsername === undefined ? existing.telegram_username : normalizeTelegramUsername(input.telegramUsername);
  const avatarUrl = input.avatarUrl === undefined ? existing.avatar_url : input.avatarUrl;
  const status = input.status ?? statusOf(existing.status);

  await db.prepare(`
    UPDATE students
    SET telegram_user_id = ?, telegram_username = ?, display_name = ?, avatar_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(telegramUserId, telegramUsername, displayName, avatarUrl, status, id).run();
  return (await listAllStudents(currentTelegramUserId)).find((student) => student.id === id) as StudentView;
}

export async function deleteStudent(id: string): Promise<void> {
  await ensureDatabase();
  const db = d1();
  await db.batch([
    db.prepare("DELETE FROM lesson_scores WHERE student_id = ?").bind(id),
    db.prepare("DELETE FROM students WHERE id = ?").bind(id),
  ]);
}

export async function setScore(studentId: string, lessonNumber: number, score: number | null): Promise<void> {
  await ensureDatabase();
  const db = d1();
  const lesson = assertLessonNumber(lessonNumber);
  const cleanScore = assertScore(score);
  const scoredAt = new Date().toISOString();
  const student = await db.prepare("SELECT id FROM students WHERE id = ?").bind(studentId).first<{ id: string }>();
  if (!student) throw new Error("Ученик не найден");

  await db.prepare(`
    INSERT INTO lesson_scores (id, student_id, lesson_number, score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, lesson_number)
    DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), studentId, lesson, cleanScore, scoredAt, scoredAt).run();
}

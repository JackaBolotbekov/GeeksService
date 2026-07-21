import { env } from "cloudflare:workers";
import { normalizeTelegramUsername, publicTelegramAvatar } from "./telegram";
import { LESSON_COUNT, type AdminStudentsResponse, type ScoreCell, type StudentStatus, type StudentView } from "./types";

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
  ]);

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

function statusOf(value: string): StudentStatus {
  return value === "pending" || value === "archived" ? value : "active";
}

function emptyScores(): ScoreCell[] {
  return Array.from({ length: LESSON_COUNT }, (_, index) => ({ lessonNumber: index + 1, score: null }));
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
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: statusOf(row.status),
    scores,
    completedLessons,
    totalScore,
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

export async function listStudents(currentTelegramUserId: string | null = null): Promise<StudentView[]> {
  await ensureDatabase();
  const db = d1();
  const studentsResult = await db.prepare("SELECT * FROM students").all<StudentRow>();
  const scoreResult = await db.prepare("SELECT student_id, lesson_number, score FROM lesson_scores").all<ScoreRow>();
  const scoresByStudent = new Map<string, ScoreCell[]>();
  for (const row of scoreResult.results ?? []) {
    const scores = scoresByStudent.get(row.student_id) ?? emptyScores();
    scores[row.lesson_number - 1] = { lessonNumber: row.lesson_number, score: row.score };
    scoresByStudent.set(row.student_id, scores);
  }

  const views = (studentsResult.results ?? []).map((row) =>
    rowToStudent(row, scoresByStudent.get(row.id) ?? emptyScores(), currentTelegramUserId),
  );
  return withRanking(views)
    .filter((student) => student.status === "active")
    .sort((left, right) => (left.place ?? 999) - (right.place ?? 999) || left.displayName.localeCompare(right.displayName, "ru"));
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
  const scoreResult = await db.prepare("SELECT student_id, lesson_number, score FROM lesson_scores").all<ScoreRow>();
  const scoresByStudent = new Map<string, ScoreCell[]>();
  for (const row of scoreResult.results ?? []) {
    const scores = scoresByStudent.get(row.student_id) ?? emptyScores();
    scores[row.lesson_number - 1] = { lessonNumber: row.lesson_number, score: row.score };
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
      await setScore(studentId, cell.lessonNumber, cell.score, currentTelegramUserId);
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

export async function setScore(studentId: string, lessonNumber: number, score: number | null, currentTelegramUserId: string | null): Promise<StudentView> {
  await ensureDatabase();
  const db = d1();
  const lesson = assertLessonNumber(lessonNumber);
  const cleanScore = assertScore(score);
  const student = await db.prepare("SELECT id FROM students WHERE id = ?").bind(studentId).first<{ id: string }>();
  if (!student) throw new Error("Ученик не найден");

  await db.prepare(`
    INSERT INTO lesson_scores (id, student_id, lesson_number, score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(student_id, lesson_number)
    DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP
  `).bind(crypto.randomUUID(), studentId, lesson, cleanScore).run();

  return (await listAllStudents(currentTelegramUserId)).find((item) => item.id === studentId) as StudentView;
}

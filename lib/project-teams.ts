import { env } from "cloudflare:workers";
import { ensureDatabase } from "./store";
import type { ProjectLeaderboardResponse, ProjectTeamView } from "./types";

type ProjectTeamRow = {
  id: string;
  name: string;
  place: number | null;
  created_at: string;
  updated_at: string;
};

type ProjectMemberRow = {
  team_id: string;
  student_id: string;
};

type ProjectTeamInput = {
  name: string;
  studentIds: string[];
  place?: number | null;
};

type ProjectTeamPatch = Partial<ProjectTeamInput>;

function d1(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("D1 database is unavailable");
  return db;
}

function cleanName(value: unknown): { name: string; nameKey: string } {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  const length = Array.from(name).length;
  if (length < 2 || length > 60) throw new Error("Название проекта должно быть от 2 до 60 символов");
  return { name, nameKey: name.toLocaleLowerCase("ru-RU") };
}

function cleanStudentIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Выберите участников проекта");
  const ids = value.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("Ученик не может быть выбран дважды");
  if (ids.length < 2 || ids.length > 5) throw new Error("В проекте должно быть от 2 до 5 учеников");
  return ids;
}

function cleanPlace(value: unknown): 1 | 2 | 3 | null {
  if (value === null || value === undefined || value === "") return null;
  const place = Number(value);
  if (place !== 1 && place !== 2 && place !== 3) throw new Error("Место должно быть первым, вторым или третьим");
  return place;
}

async function assertTeamNameAvailable(db: D1Database, nameKey: string, exceptTeamId?: string): Promise<void> {
  const row = await db.prepare(`
    SELECT id
    FROM project_teams
    WHERE name_key = ? AND (? IS NULL OR id <> ?)
    LIMIT 1
  `).bind(nameKey, exceptTeamId ?? null, exceptTeamId ?? null).first<{ id: string }>();
  if (row) throw new Error("Проект с таким названием уже существует");
}

async function assertStudentsAvailable(db: D1Database, studentIds: string[], exceptTeamId?: string): Promise<void> {
  const placeholders = studentIds.map(() => "?").join(", ");
  const active = await db.prepare(`
    SELECT id
    FROM students
    WHERE status = 'active' AND id IN (${placeholders})
  `).bind(...studentIds).all<{ id: string }>();
  if ((active.results ?? []).length !== studentIds.length) throw new Error("Все участники должны быть активными учениками");

  const membership = await db.prepare(`
    SELECT student_id, team_id
    FROM project_team_members
    WHERE student_id IN (${placeholders})
  `).bind(...studentIds).all<{ student_id: string; team_id: string }>();
  const occupied = (membership.results ?? []).find((row) => row.team_id !== exceptTeamId);
  if (occupied) throw new Error("Один из учеников уже состоит в другом проекте");
}

export async function listProjectTeams(): Promise<ProjectLeaderboardResponse> {
  await ensureDatabase();
  const db = d1();
  const [teamsResult, membersResult] = await Promise.all([
    db.prepare(`
      SELECT id, name, place, created_at, updated_at
      FROM project_teams
      ORDER BY CASE WHEN place IS NULL THEN 1 ELSE 0 END, place ASC, created_at ASC
    `).all<ProjectTeamRow>(),
    db.prepare(`
      SELECT team_id, student_id
      FROM project_team_members
      ORDER BY team_id ASC, sort_order ASC, created_at ASC
    `).all<ProjectMemberRow>(),
  ]);
  const memberIds = new Map<string, string[]>();
  for (const row of membersResult.results ?? []) {
    const ids = memberIds.get(row.team_id) ?? [];
    ids.push(row.student_id);
    memberIds.set(row.team_id, ids);
  }
  const teams: ProjectTeamView[] = (teamsResult.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    place: row.place === 1 || row.place === 2 || row.place === 3 ? row.place : null,
    memberIds: memberIds.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return { teams };
}

export async function createProjectTeam(input: ProjectTeamInput): Promise<ProjectLeaderboardResponse> {
  await ensureDatabase();
  const db = d1();
  const { name, nameKey } = cleanName(input.name);
  const studentIds = cleanStudentIds(input.studentIds);
  const place = cleanPlace(input.place);
  await assertTeamNameAvailable(db, nameKey);
  await assertStudentsAvailable(db, studentIds);

  const id = crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (place !== null) {
    statements.push(db.prepare("UPDATE project_teams SET place = NULL, updated_at = ? WHERE place = ?").bind(updatedAt, place));
  }
  statements.push(db.prepare(`
    INSERT INTO project_teams (id, name, name_key, place, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, name, nameKey, place, updatedAt, updatedAt));
  studentIds.forEach((studentId, index) => {
    statements.push(db.prepare(`
      INSERT INTO project_team_members (team_id, student_id, sort_order, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(id, studentId, index, updatedAt));
  });
  await db.batch(statements);
  return listProjectTeams();
}

export async function updateProjectTeam(teamId: string, patch: ProjectTeamPatch): Promise<ProjectLeaderboardResponse> {
  await ensureDatabase();
  const db = d1();
  const existing = await db.prepare(`
    SELECT id, name, name_key, place
    FROM project_teams
    WHERE id = ?
  `).bind(teamId).first<{ id: string; name: string; name_key: string; place: number | null }>();
  if (!existing) throw new Error("Проект не найден");

  const cleanedName = patch.name === undefined
    ? { name: existing.name, nameKey: existing.name_key }
    : cleanName(patch.name);
  const place = patch.place === undefined
    ? cleanPlace(existing.place)
    : cleanPlace(patch.place);
  const studentIds = patch.studentIds === undefined
    ? (await db.prepare(`
        SELECT student_id
        FROM project_team_members
        WHERE team_id = ?
        ORDER BY sort_order ASC, created_at ASC
      `).bind(teamId).all<{ student_id: string }>()).results?.map((row) => row.student_id) ?? []
    : cleanStudentIds(patch.studentIds);
  cleanStudentIds(studentIds);
  await assertTeamNameAvailable(db, cleanedName.nameKey, teamId);
  await assertStudentsAvailable(db, studentIds, teamId);

  const updatedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (place !== null) {
    statements.push(db.prepare(`
      UPDATE project_teams
      SET place = NULL, updated_at = ?
      WHERE place = ? AND id <> ?
    `).bind(updatedAt, place, teamId));
  }
  statements.push(db.prepare(`
    UPDATE project_teams
    SET name = ?, name_key = ?, place = ?, updated_at = ?
    WHERE id = ?
  `).bind(cleanedName.name, cleanedName.nameKey, place, updatedAt, teamId));
  if (patch.studentIds !== undefined) {
    statements.push(db.prepare("DELETE FROM project_team_members WHERE team_id = ?").bind(teamId));
    studentIds.forEach((studentId, index) => {
      statements.push(db.prepare(`
        INSERT INTO project_team_members (team_id, student_id, sort_order, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(teamId, studentId, index, updatedAt));
    });
  }
  await db.batch(statements);
  return listProjectTeams();
}

export async function deleteProjectTeam(teamId: string): Promise<ProjectLeaderboardResponse> {
  await ensureDatabase();
  const db = d1();
  const result = await db.batch([
    db.prepare("DELETE FROM project_team_members WHERE team_id = ?").bind(teamId),
    db.prepare("DELETE FROM project_teams WHERE id = ?").bind(teamId),
  ]);
  if ((result.at(-1)?.meta?.changes ?? 0) < 1) throw new Error("Проект не найден");
  return listProjectTeams();
}

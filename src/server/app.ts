import { resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  type AdminStudentsResponse,
  type AuthResponse,
  type LeaderboardResponse,
  type MeResponse,
  type SessionIdentity,
  type StudentStatus,
  type StudentView,
} from "../shared/types";
import { buildLeaderboard, toStudentView, type StoredStudent } from "./leaderboard";
import { createSessionToken, verifySessionToken } from "./session";
import { type StudentStore, createStudentStore, normalizeTelegramUsername } from "./student-store";
import { validateTelegramInitData, type TelegramUser } from "./telegram";
import {
  defaultAvatarStorageDir,
  resolveTelegramAvatarUrl,
  resolveTelegramPublicAvatarByUsername,
  resolveTelegramUserByUsername,
} from "./telegram-avatar";

export interface AppOptions {
  store?: StudentStore;
  sessionSecret?: string;
  botToken?: string;
  allowDevAuth?: boolean;
  adminTelegramIds?: string[];
  staticRoot?: string | null;
  avatarStorageDir?: string | null;
}

const nameSchema = z.string().trim().min(2).max(60);
const statusSchema = z.union([z.literal("pending"), z.literal("active"), z.literal("archived")]);
const telegramIdSchema = z.string().trim().regex(/^\d{1,20}$/);
const telegramUsernameSchema = z.string().trim().regex(/^@?[a-zA-Z0-9_]{5,32}$/);
const optionalTelegramIdSchema = z.union([telegramIdSchema, z.literal(""), z.null()]).optional();
const optionalTelegramUsernameSchema = z.union([telegramUsernameSchema, z.literal(""), z.null()]).optional();
const optionalTelegramContactSchema = z.union([telegramIdSchema, telegramUsernameSchema, z.literal(""), z.null()]).optional();
const studentPatchSchema = z.object({
  displayName: nameSchema.optional(),
  telegramUserId: optionalTelegramIdSchema,
  telegramUsername: optionalTelegramUsernameSchema,
  telegram: optionalTelegramContactSchema,
  avatarUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
  status: statusSchema.optional(),
});
const studentCreateSchema = z.object({
  displayName: nameSchema,
  telegramUserId: optionalTelegramIdSchema,
  telegramUsername: optionalTelegramUsernameSchema,
  telegram: optionalTelegramContactSchema,
  status: statusSchema.optional(),
});
const scoreSchema = z.object({
  score: z.union([z.number().int().min(1).max(10), z.null()]),
});
const avatarSyncTtlMs = 6 * 60 * 60 * 1000;

function parseAdminIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function telegramDisplayName(user: TelegramUser): string {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || `Ученик ${user.id}`;
}

function cleanNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseTelegramContact(input: {
  telegram?: string | null;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
}): { telegramUserId?: string | null; telegramUsername?: string | null } {
  const explicitId = cleanNullableText(input.telegramUserId);
  const explicitUsernameText = cleanNullableText(input.telegramUsername);
  const explicitUsername = explicitUsernameText === undefined ? undefined : normalizeTelegramUsername(explicitUsernameText);
  const contact = cleanNullableText(input.telegram);
  if (!contact) {
    return {
      telegramUserId: explicitId,
      telegramUsername: explicitUsername,
    };
  }
  if (/^\d{1,20}$/.test(contact)) {
    return {
      telegramUserId: contact,
      telegramUsername: explicitUsername,
    };
  }
  return {
    telegramUserId: explicitId,
    telegramUsername: normalizeTelegramUsername(contact),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Что-то пошло не так";
}

export function createApp(options: AppOptions = {}): Express {
  const isProduction = process.env.NODE_ENV === "production";
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET ?? "geeks-service-local-secret";
  const botToken = options.botToken ?? process.env.BOT_TOKEN;
  const allowDevAuth = options.allowDevAuth ?? (process.env.ALLOW_DEV_AUTH === "true" || !isProduction);
  const adminIds = new Set(options.adminTelegramIds ?? parseAdminIds(process.env.ADMIN_TELEGRAM_IDS));
  const store = options.store ?? createStudentStore();
  const staticRoot = options.staticRoot === undefined ? resolve("dist/client") : options.staticRoot;
  const avatarStorageDir = options.avatarStorageDir === null ? null : (options.avatarStorageDir ?? defaultAvatarStorageDir());

  if (isProduction && !process.env.SESSION_SECRET) {
    console.warn("SESSION_SECRET is not configured; set it before production use.");
  }
  if (isProduction && !botToken) {
    console.warn("BOT_TOKEN is not configured; Telegram login is disabled.");
  }
  if (isProduction && adminIds.size === 0) {
    console.warn("ADMIN_TELEGRAM_IDS is not configured; admin panel is disabled.");
  }

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const avatarSyncAttempts = new Map<string, number>();
  if (avatarStorageDir) {
    app.use("/avatars", express.static(avatarStorageDir, { maxAge: "7d", immutable: true }));
  }

  function isTelegramAdmin(telegramUserId: string | undefined): boolean {
    return Boolean(telegramUserId && adminIds.has(telegramUserId));
  }

  function bearerIdentity(request: Request): SessionIdentity | null {
    const authorization = request.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    return token ? verifySessionToken(token, sessionSecret) : null;
  }

  function authResponse(identity: SessionIdentity): AuthResponse {
    return {
      sessionToken: createSessionToken(identity, sessionSecret),
      profile: {
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        kind: identity.kind,
        isAdmin: identity.isAdmin,
      },
    };
  }

  function requireIdentity(request: Request, response: Response): SessionIdentity | null {
    const identity = bearerIdentity(request);
    if (!identity) {
      response.status(401).json({ message: "Требуется вход через Telegram" });
      return null;
    }
    return {
      ...identity,
      isAdmin: identity.isAdmin || isTelegramAdmin(identity.telegramUserId),
    };
  }

  function requireAdmin(request: Request, response: Response): SessionIdentity | null {
    const identity = requireIdentity(request, response);
    if (!identity) return null;
    if (!identity.isAdmin) {
      response.status(403).json({ message: "Только админ может менять учеников и оценки" });
      return null;
    }
    return identity;
  }

  async function studentView(student: StoredStudent, currentTelegramUserId: string | null): Promise<StudentView> {
    const leaderboard = buildLeaderboard(await store.listStudents(), currentTelegramUserId);
    return leaderboard.find((item) => item.id === student.id) ?? toStudentView(student, currentTelegramUserId);
  }

  async function avatarForTelegramUser(user: TelegramUser, telegramUserId: string): Promise<string | null> {
    if (!botToken || !avatarStorageDir) return user.photo_url ?? null;
    return await resolveTelegramAvatarUrl({
      botToken,
      telegramUserId,
      initPhotoUrl: user.photo_url ?? null,
      storageDir: avatarStorageDir,
    }) ?? user.photo_url ?? null;
  }

  async function syncKnownStudentAvatars(students: StoredStudent[]): Promise<void> {
    if (!botToken || !avatarStorageDir) return;

    await Promise.all(students.map(async (student) => {
      const syncKey = `${student.id}:${student.telegramUserId ?? student.telegramUsername ?? ""}`;
      if (syncKey.endsWith(":")) return;
      const lastAttemptAt = avatarSyncAttempts.get(syncKey) ?? 0;
      if (Date.now() - lastAttemptAt < avatarSyncTtlMs) return;
      avatarSyncAttempts.set(syncKey, Date.now());

      try {
        let telegramUserId = student.telegramUserId;
        const patch: { telegramUserId?: string | null; avatarUrl?: string | null } = {};

        if (!telegramUserId && student.telegramUsername) {
          const resolved = await resolveTelegramUserByUsername({
            botToken,
            telegramUsername: student.telegramUsername,
            storageDir: avatarStorageDir,
          });
          if (resolved?.telegramUserId) {
            telegramUserId = resolved.telegramUserId;
            patch.telegramUserId = resolved.telegramUserId;
            if (resolved.avatarUrl) patch.avatarUrl = resolved.avatarUrl;
          }
        }

        if (telegramUserId && !patch.avatarUrl) {
          const avatarUrl = await resolveTelegramAvatarUrl({ botToken, telegramUserId, storageDir: avatarStorageDir });
          if (avatarUrl) patch.avatarUrl = avatarUrl;
        }

        if (!patch.avatarUrl && student.telegramUsername) {
          const avatarUrl = await resolveTelegramPublicAvatarByUsername({
            telegramUsername: student.telegramUsername,
            storageDir: avatarStorageDir,
          });
          if (avatarUrl) patch.avatarUrl = avatarUrl;
        }

        if (Object.keys(patch).length > 0) {
          await store.updateStudent(student.id, patch);
        }
      } catch {
        console.warn("Student avatar sync failed");
      }
    }));
  }

  async function adminStudentsResponse(currentTelegramUserId: string | null): Promise<AdminStudentsResponse> {
    let students = await store.listStudents();
    await syncKnownStudentAvatars(students);
    students = await store.listStudents();
    const leaderboard = buildLeaderboard(students, currentTelegramUserId);
    const byId = new Map(leaderboard.map((student) => [student.id, student]));
    return {
      students: students
        .filter((student) => student.status !== "pending")
        .map((student) => byId.get(student.id) ?? toStudentView(student, currentTelegramUserId))
        .sort((left, right) => {
          if (left.status !== right.status) return left.status === "active" ? -1 : 1;
          return (left.place ?? 999) - (right.place ?? 999) || left.displayName.localeCompare(right.displayName, "ru");
        }),
      pendingStudents: students
        .filter((student) => student.status === "pending")
        .map((student) => toStudentView(student, currentTelegramUserId))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, "ru")),
    };
  }

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      telegramConfigured: Boolean(botToken),
      devAuth: allowDevAuth,
    });
  });

  app.post("/api/auth/telegram", async (request, response) => {
    if (!botToken) {
      response.status(503).json({ message: "Telegram-вход пока не настроен" });
      return;
    }
    const parsed = z.object({ initData: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Telegram initData отсутствует" });
      return;
    }

    try {
      const telegramUser = validateTelegramInitData(parsed.data.initData, botToken);
      const telegramUserId = String(telegramUser.id);
      const isAdmin = isTelegramAdmin(telegramUserId);
      const avatarUrl = await avatarForTelegramUser(telegramUser, telegramUserId);
      const student = isAdmin
        ? null
        : await store.upsertTelegramStudent({
            telegramUserId,
            telegramUsername: telegramUser.username ?? null,
            displayName: telegramDisplayName(telegramUser),
            avatarUrl,
          });
      response.json(authResponse({
        sub: `telegram:${telegramUserId}`,
        kind: "telegram",
        telegramUserId,
        displayName: student?.displayName ?? telegramDisplayName(telegramUser),
        avatarUrl: student?.avatarUrl ?? avatarUrl,
        isAdmin,
      }));
    } catch (error) {
      console.error("Telegram authentication failed", error);
      response.status(401).json({ message: "Не удалось подтвердить вход через Telegram" });
    }
  });

  app.post("/api/auth/dev", async (request, response) => {
    if (!allowDevAuth) {
      response.status(404).json({ message: "Not found" });
      return;
    }
    const parsed = z.object({
      displayName: nameSchema,
      telegramUserId: telegramIdSchema.optional(),
      admin: z.boolean().optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Некорректные данные dev-входа" });
      return;
    }
    const telegramUserId = parsed.data.telegramUserId ?? String(Math.floor(Math.random() * 1_000_000_000));
    const isAdmin = Boolean(parsed.data.admin);
    const student = isAdmin
      ? null
      : await store.upsertTelegramStudent({
          telegramUserId,
          telegramUsername: null,
          displayName: parsed.data.displayName,
          avatarUrl: null,
        });
    response.json(authResponse({
      sub: `dev:${telegramUserId}`,
      kind: "dev",
      telegramUserId,
      displayName: student?.displayName ?? parsed.data.displayName,
      avatarUrl: student?.avatarUrl ?? null,
      isAdmin,
    }));
  });

  app.get("/api/me", async (request, response) => {
    const identity = requireIdentity(request, response);
    if (!identity) return;
    const student = identity.telegramUserId ? await store.findByTelegramUserId(identity.telegramUserId) : null;
    const view = student ? await studentView(student, identity.telegramUserId ?? null) : null;
    const body: MeResponse = {
      isAdmin: identity.isAdmin,
      student: view,
      pending: Boolean(view && view.status === "pending"),
    };
    response.json(body);
  });

  app.get("/api/leaderboard", async (request, response) => {
    const identity = bearerIdentity(request);
    const currentTelegramUserId = identity?.telegramUserId ?? null;
    const body: LeaderboardResponse = {
      students: buildLeaderboard(await store.listStudents(), currentTelegramUserId),
    };
    response.json(body);
  });

  app.get("/api/admin/students", async (request, response) => {
    const identity = requireAdmin(request, response);
    if (!identity) return;
    response.json(await adminStudentsResponse(identity.telegramUserId ?? null));
  });

  app.post("/api/admin/students", async (request, response) => {
    const identity = requireAdmin(request, response);
    if (!identity) return;
    const parsed = studentCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Имя ученика обязательно, Telegram ID должен быть числом" });
      return;
    }
    try {
      const telegramContact = parseTelegramContact(parsed.data);
      const displayName = parsed.data.displayName.trim();
      const students = await store.listStudents();
      const existingByName = students.find((student) =>
        student.displayName.trim().localeCompare(displayName, "ru", { sensitivity: "accent" }) === 0
        && !student.telegramUserId
        && !student.telegramUsername,
      );

      if (existingByName && (telegramContact.telegramUserId || telegramContact.telegramUsername)) {
        await store.updateStudent(existingByName.id, {
          telegramUserId: telegramContact.telegramUserId,
          telegramUsername: telegramContact.telegramUsername,
          status: parsed.data.status ?? existingByName.status,
        });
      } else {
        await store.createStudent({
          displayName,
          telegramUserId: telegramContact.telegramUserId,
          telegramUsername: telegramContact.telegramUsername,
          status: parsed.data.status ?? "active",
        });
      }
      response.status(201).json(await adminStudentsResponse(identity.telegramUserId ?? null));
    } catch (error) {
      response.status(400).json({ message: errorMessage(error) });
    }
  });

  app.patch("/api/admin/students/:studentId", async (request, response) => {
    const identity = requireAdmin(request, response);
    if (!identity) return;
    const parsed = studentPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Некорректные данные ученика" });
      return;
    }
    try {
      const telegramContact = parseTelegramContact(parsed.data);
      await store.updateStudent(request.params.studentId, {
        displayName: parsed.data.displayName,
        telegramUserId: telegramContact.telegramUserId,
        telegramUsername: telegramContact.telegramUsername,
        avatarUrl: cleanNullableText(parsed.data.avatarUrl),
        status: parsed.data.status as StudentStatus | undefined,
      });
      response.json(await adminStudentsResponse(identity.telegramUserId ?? null));
    } catch (error) {
      response.status(400).json({ message: errorMessage(error) });
    }
  });

  app.put("/api/admin/students/:studentId/scores/:lessonNumber", async (request, response) => {
    const identity = requireAdmin(request, response);
    if (!identity) return;
    const lessonNumber = Number(request.params.lessonNumber);
    const parsed = scoreSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Оценка должна быть от 1 до 10 или null" });
      return;
    }
    try {
      await store.setScore(request.params.studentId, lessonNumber, parsed.data.score);
      response.json(await adminStudentsResponse(identity.telegramUserId ?? null));
    } catch (error) {
      response.status(400).json({ message: errorMessage(error) });
    }
  });

  if (staticRoot) {
    app.use(express.static(staticRoot));
    app.get(/.*/, (_request, response) => {
      response.sendFile(resolve(staticRoot, "index.html"));
    });
  }

  return app;
}

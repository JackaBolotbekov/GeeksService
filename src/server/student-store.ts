import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertLessonNumber, assertScore, normalizeScores, type StoredStudent } from "./leaderboard";
import { getPrismaClient } from "./prisma";
import type { ScoreCell, StudentStatus } from "../shared/types";

export interface UpsertTelegramStudentInput {
  telegramUserId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface StudentCreateInput {
  displayName: string;
  telegramUserId?: string | null;
  avatarUrl?: string | null;
  status?: StudentStatus;
}

export interface StudentPatchInput {
  displayName?: string;
  telegramUserId?: string | null;
  avatarUrl?: string | null;
  status?: StudentStatus;
}

export interface StudentStore {
  upsertTelegramStudent(input: UpsertTelegramStudentInput): Promise<StoredStudent>;
  listStudents(): Promise<StoredStudent[]>;
  findByTelegramUserId(telegramUserId: string): Promise<StoredStudent | null>;
  createStudent(input: StudentCreateInput): Promise<StoredStudent>;
  updateStudent(id: string, input: StudentPatchInput): Promise<StoredStudent>;
  setScore(studentId: string, lessonNumber: number, score: number | null): Promise<StoredStudent>;
}

const validStatuses = new Set<StudentStatus>(["pending", "active", "archived"]);

function normalizeStatus(status: string): StudentStatus {
  return validStatuses.has(status as StudentStatus) ? status as StudentStatus : "pending";
}

function validateStudentInput(input: StudentCreateInput | StudentPatchInput): void {
  if ("displayName" in input && input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (name.length < 2 || name.length > 60) throw new Error("displayName must be 2-60 characters");
  }
  if (input.status !== undefined && !validStatuses.has(input.status)) throw new Error("invalid student status");
  if (input.telegramUserId !== undefined && input.telegramUserId !== null && !/^\d{1,20}$/.test(input.telegramUserId)) {
    throw new Error("telegramUserId must contain digits only");
  }
}

function emptyScores(): ScoreCell[] {
  return Array.from({ length: 12 }, (_, index) => ({ lessonNumber: index + 1, score: null }));
}

export class MemoryStudentStore implements StudentStore {
  private readonly students = new Map<string, StoredStudent>();

  async upsertTelegramStudent(input: UpsertTelegramStudentInput): Promise<StoredStudent> {
    const existing = [...this.students.values()].find((student) => student.telegramUserId === input.telegramUserId);
    if (existing) {
      const updated = {
        ...existing,
        avatarUrl: input.avatarUrl,
      };
      this.students.set(updated.id, updated);
      return updated;
    }
    return this.createStudent({
      displayName: input.displayName,
      telegramUserId: input.telegramUserId,
      avatarUrl: input.avatarUrl,
      status: "pending",
    });
  }

  async listStudents(): Promise<StoredStudent[]> {
    return [...this.students.values()].map((student) => ({ ...student, scores: normalizeScores(student.scores) }));
  }

  async findByTelegramUserId(telegramUserId: string): Promise<StoredStudent | null> {
    return [...this.students.values()].find((student) => student.telegramUserId === telegramUserId) ?? null;
  }

  async createStudent(input: StudentCreateInput): Promise<StoredStudent> {
    validateStudentInput(input);
    if (input.telegramUserId && [...this.students.values()].some((student) => student.telegramUserId === input.telegramUserId)) {
      throw new Error("telegramUserId already exists");
    }
    const student: StoredStudent = {
      id: randomUUID(),
      telegramUserId: input.telegramUserId ?? null,
      displayName: input.displayName.trim(),
      avatarUrl: input.avatarUrl ?? null,
      status: input.status ?? "active",
      scores: emptyScores(),
    };
    this.students.set(student.id, student);
    return student;
  }

  async updateStudent(id: string, input: StudentPatchInput): Promise<StoredStudent> {
    validateStudentInput(input);
    const existing = this.students.get(id);
    if (!existing) throw new Error("student not found");
    if (
      input.telegramUserId &&
      [...this.students.values()].some((student) => student.id !== id && student.telegramUserId === input.telegramUserId)
    ) {
      throw new Error("telegramUserId already exists");
    }
    const updated = {
      ...existing,
      displayName: input.displayName === undefined ? existing.displayName : input.displayName.trim(),
      telegramUserId: input.telegramUserId === undefined ? existing.telegramUserId : input.telegramUserId,
      avatarUrl: input.avatarUrl === undefined ? existing.avatarUrl : input.avatarUrl,
      status: input.status ?? existing.status,
    };
    this.students.set(id, updated);
    return updated;
  }

  async setScore(studentId: string, lessonNumber: number, score: number | null): Promise<StoredStudent> {
    assertLessonNumber(lessonNumber);
    assertScore(score);
    const existing = this.students.get(studentId);
    if (!existing) throw new Error("student not found");
    const scores = normalizeScores(existing.scores).map((cell) =>
      cell.lessonNumber === lessonNumber ? { ...cell, score } : cell,
    );
    const updated = { ...existing, scores };
    this.students.set(studentId, updated);
    return updated;
  }
}

type PrismaStudent = {
  id: string;
  telegramUserId: bigint | null;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  scores: { lessonNumber: number; score: number | null }[];
};

function fromPrisma(student: PrismaStudent): StoredStudent {
  return {
    id: student.id,
    telegramUserId: student.telegramUserId?.toString() ?? null,
    displayName: student.displayName,
    avatarUrl: student.avatarUrl,
    status: normalizeStatus(student.status),
    scores: normalizeScores(student.scores),
  };
}

export class PrismaStudentStore implements StudentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertTelegramStudent(input: UpsertTelegramStudentInput): Promise<StoredStudent> {
    const student = await this.prisma.student.upsert({
      where: { telegramUserId: BigInt(input.telegramUserId) },
      create: {
        telegramUserId: BigInt(input.telegramUserId),
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        status: "pending",
        lastSeenAt: new Date(),
      },
      update: {
        avatarUrl: input.avatarUrl,
        lastSeenAt: new Date(),
      },
      include: { scores: true },
    });
    return fromPrisma(student);
  }

  async listStudents(): Promise<StoredStudent[]> {
    const students = await this.prisma.student.findMany({
      orderBy: { displayName: "asc" },
      include: { scores: true },
    });
    return students.map(fromPrisma);
  }

  async findByTelegramUserId(telegramUserId: string): Promise<StoredStudent | null> {
    const student = await this.prisma.student.findUnique({
      where: { telegramUserId: BigInt(telegramUserId) },
      include: { scores: true },
    });
    return student ? fromPrisma(student) : null;
  }

  async createStudent(input: StudentCreateInput): Promise<StoredStudent> {
    validateStudentInput(input);
    const student = await this.prisma.student.create({
      data: {
        displayName: input.displayName.trim(),
        telegramUserId: input.telegramUserId ? BigInt(input.telegramUserId) : null,
        avatarUrl: input.avatarUrl ?? null,
        status: input.status ?? "active",
      },
      include: { scores: true },
    });
    return fromPrisma(student);
  }

  async updateStudent(id: string, input: StudentPatchInput): Promise<StoredStudent> {
    validateStudentInput(input);
    const student = await this.prisma.student.update({
      where: { id },
      data: {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
        ...(input.telegramUserId === undefined ? {} : { telegramUserId: input.telegramUserId ? BigInt(input.telegramUserId) : null }),
        ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
      include: { scores: true },
    });
    return fromPrisma(student);
  }

  async setScore(studentId: string, lessonNumber: number, score: number | null): Promise<StoredStudent> {
    assertLessonNumber(lessonNumber);
    assertScore(score);
    await this.prisma.lessonScore.upsert({
      where: { studentId_lessonNumber: { studentId, lessonNumber } },
      create: { studentId, lessonNumber, score },
      update: { score },
    });
    const student = await this.prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      include: { scores: true },
    });
    return fromPrisma(student);
  }
}

export function createStudentStore(): StudentStore {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not configured; students use temporary memory storage.");
    return new MemoryStudentStore();
  }
  return new PrismaStudentStore(getPrismaClient());
}

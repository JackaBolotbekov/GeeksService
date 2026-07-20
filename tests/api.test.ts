import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { MemoryStudentStore } from "../src/server/student-store";
import type { AdminStudentsResponse, AuthResponse, LeaderboardResponse, MeResponse } from "../src/shared/types";

let server: Server;
let baseUrl: string;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data as T;
}

async function login(admin = false, telegramUserId = admin ? "1291298838" : "9001"): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/dev", {
    method: "POST",
    body: JSON.stringify({ displayName: admin ? "Admin" : "Student", telegramUserId, admin }),
  });
}

beforeEach(async () => {
  const app = createApp({
    store: new MemoryStudentStore(),
    sessionSecret: "test-secret",
    allowDevAuth: true,
    adminTelegramIds: ["1291298838"],
    staticRoot: null,
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("Geeks Service API", () => {
  it("creates pending student on first login", async () => {
    const auth = await login(false, "555");
    const me = await request<MeResponse>("/api/me", {
      headers: { Authorization: `Bearer ${auth.sessionToken}` },
    });

    expect(me.pending).toBe(true);
    expect(me.student?.status).toBe("pending");
  });

  it("blocks admin endpoints for non-admins", async () => {
    const auth = await login(false, "556");

    await expect(request("/api/admin/students", {
      headers: { Authorization: `Bearer ${auth.sessionToken}` },
    })).rejects.toThrow("Только админ");
  });

  it("lets admin add a student, set score and update leaderboard", async () => {
    const admin = await login(true);
    const adminHeaders = { Authorization: `Bearer ${admin.sessionToken}` };
    const created = await request<AdminStudentsResponse>("/api/admin/students", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ displayName: "Алия", telegramUserId: "7001" }),
    });
    const student = created.students.find((item) => item.displayName === "Алия");
    expect(student).toBeDefined();

    await request<AdminStudentsResponse>(`/api/admin/students/${student?.id}/scores/1`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ score: 10 }),
    });
    await request<AdminStudentsResponse>(`/api/admin/students/${student?.id}/scores/2`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ score: 9 }),
    });
    const leaderboard = await request<LeaderboardResponse>("/api/leaderboard");

    expect(leaderboard.students[0]).toMatchObject({
      displayName: "Алия",
      totalScore: 19,
      completedLessons: 2,
      place: 1,
    });
  });

  it("lets admin approve a pending student", async () => {
    await login(false, "8001");
    const admin = await login(true);
    const adminHeaders = { Authorization: `Bearer ${admin.sessionToken}` };
    const before = await request<AdminStudentsResponse>("/api/admin/students", { headers: adminHeaders });
    const pending = before.pendingStudents[0];

    await request<AdminStudentsResponse>(`/api/admin/students/${pending.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "active", displayName: "Бек" }),
    });
    const leaderboard = await request<LeaderboardResponse>("/api/leaderboard");

    expect(leaderboard.students.map((item) => item.displayName)).toContain("Бек");
  });
});

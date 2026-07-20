import { describe, expect, it } from "vitest";
import { MemoryStudentStore } from "../src/server/student-store";

describe("MemoryStudentStore", () => {
  it("creates an unknown Telegram user as pending", async () => {
    const store = new MemoryStudentStore();
    const student = await store.upsertTelegramStudent({
      telegramUserId: "1001",
      displayName: "Jacka",
      avatarUrl: "https://example.com/a.jpg",
    });

    expect(student.status).toBe("pending");
    expect(student.telegramUserId).toBe("1001");
  });

  it("updates score idempotently per student and lesson", async () => {
    const store = new MemoryStudentStore();
    const student = await store.createStudent({ displayName: "Meder" });

    await store.setScore(student.id, 1, 5);
    const updated = await store.setScore(student.id, 1, 10);

    expect(updated.scores.find((score) => score.lessonNumber === 1)?.score).toBe(10);
    expect(updated.scores.filter((score) => score.score !== null)).toHaveLength(1);
  });

  it("rejects duplicate Telegram IDs", async () => {
    const store = new MemoryStudentStore();
    await store.createStudent({ displayName: "One", telegramUserId: "77" });

    await expect(store.createStudent({ displayName: "Two", telegramUserId: "77" })).rejects.toThrow("telegramUserId");
  });
});

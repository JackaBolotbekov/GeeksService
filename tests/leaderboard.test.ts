import { describe, expect, it } from "vitest";
import { assertLessonNumber, assertScore, buildLeaderboard, type StoredStudent } from "../src/server/leaderboard";

function student(input: Partial<StoredStudent> & { id: string; displayName: string }): StoredStudent {
  return {
    telegramUserId: null,
    avatarUrl: null,
    status: "active",
    scores: [],
    ...input,
  };
}

describe("leaderboard", () => {
  it("sums scores, counts completed lessons and calculates points behind leader", () => {
    const result = buildLeaderboard([
      student({
        id: "one",
        displayName: "Алия",
        scores: [{ lessonNumber: 1, score: 10 }, { lessonNumber: 2, score: 9 }],
      }),
      student({
        id: "two",
        displayName: "Бек",
        scores: [{ lessonNumber: 1, score: 7 }],
      }),
    ], null);

    expect(result[0]).toMatchObject({ displayName: "Алия", totalScore: 19, completedLessons: 2, place: 1 });
    expect(result[1]).toMatchObject({ displayName: "Бек", totalScore: 7, completedLessons: 1, place: 2, pointsBehindLeader: 12 });
  });

  it("sorts by total score, completed lessons and name", () => {
    const result = buildLeaderboard([
      student({ id: "three", displayName: "Чынгыз", scores: [{ lessonNumber: 1, score: 8 }] }),
      student({ id: "one", displayName: "Алия", scores: [{ lessonNumber: 1, score: 8 }, { lessonNumber: 2, score: null }] }),
      student({ id: "two", displayName: "Бек", scores: [{ lessonNumber: 1, score: 8 }, { lessonNumber: 2, score: 1 }] }),
    ], null);

    expect(result.map((item) => item.displayName)).toEqual(["Бек", "Алия", "Чынгыз"]);
  });

  it("does not include pending or archived students", () => {
    const result = buildLeaderboard([
      student({ id: "active", displayName: "Active" }),
      student({ id: "pending", displayName: "Pending", status: "pending" }),
      student({ id: "archived", displayName: "Archived", status: "archived" }),
    ], null);

    expect(result.map((item) => item.id)).toEqual(["active"]);
  });

  it("validates lesson number and score boundaries", () => {
    expect(() => assertLessonNumber(0)).toThrow("lessonNumber");
    expect(() => assertLessonNumber(13)).toThrow("lessonNumber");
    expect(() => assertScore(0)).toThrow("score");
    expect(() => assertScore(11)).toThrow("score");
    expect(() => assertScore(10)).not.toThrow();
    expect(() => assertScore(null)).not.toThrow();
  });
});

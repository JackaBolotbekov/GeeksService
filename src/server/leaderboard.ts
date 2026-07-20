import { LESSON_COUNT, type ScoreCell, type StudentStatus, type StudentView } from "../shared/types";

export interface StoredStudent {
  id: string;
  telegramUserId: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: StudentStatus;
  scores: ScoreCell[];
}

export function normalizeScores(scores: ScoreCell[]): ScoreCell[] {
  const byLesson = new Map(scores.map((score) => [score.lessonNumber, score.score]));
  return Array.from({ length: LESSON_COUNT }, (_, index) => {
    const lessonNumber = index + 1;
    const score = byLesson.get(lessonNumber);
    return {
      lessonNumber,
      score: typeof score === "number" ? score : null,
    };
  });
}

export function assertLessonNumber(lessonNumber: number): void {
  if (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > LESSON_COUNT) {
    throw new Error(`lessonNumber must be between 1 and ${LESSON_COUNT}`);
  }
}

export function assertScore(score: number | null): void {
  if (score === null) return;
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error("score must be between 1 and 10");
  }
}

export function toStudentView(student: StoredStudent, currentTelegramUserId: string | null): StudentView {
  const scores = normalizeScores(student.scores);
  const completedLessons = scores.filter((score) => score.score !== null).length;
  const totalScore = scores.reduce((sum, score) => sum + (score.score ?? 0), 0);
  return {
    ...student,
    scores,
    completedLessons,
    totalScore,
    place: null,
    pointsBehindLeader: 0,
    isCurrentUser: Boolean(currentTelegramUserId && student.telegramUserId === currentTelegramUserId),
  };
}

export function buildLeaderboard(students: StoredStudent[], currentTelegramUserId: string | null): StudentView[] {
  const ranked = students
    .filter((student) => student.status === "active")
    .map((student) => toStudentView(student, currentTelegramUserId))
    .sort((left, right) => {
      if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
      if (right.completedLessons !== left.completedLessons) return right.completedLessons - left.completedLessons;
      return left.displayName.localeCompare(right.displayName, "ru");
    });
  const leaderScore = ranked[0]?.totalScore ?? 0;
  return ranked.map((student, index) => ({
    ...student,
    place: index + 1,
    pointsBehindLeader: Math.max(0, leaderScore - student.totalScore),
  }));
}

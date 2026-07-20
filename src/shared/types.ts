export const LESSON_COUNT = 12;

export type StudentStatus = "pending" | "active" | "archived";

export interface SessionIdentity {
  sub: string;
  kind: "telegram" | "dev";
  telegramUserId?: string;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface ScoreCell {
  lessonNumber: number;
  score: number | null;
}

export interface StudentView {
  id: string;
  telegramUserId: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: StudentStatus;
  scores: ScoreCell[];
  completedLessons: number;
  totalScore: number;
  place: number | null;
  pointsBehindLeader: number;
  isCurrentUser: boolean;
}

export interface AuthResponse {
  sessionToken: string;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
    kind: "telegram" | "dev";
    isAdmin: boolean;
  };
}

export interface MeResponse {
  isAdmin: boolean;
  student: StudentView | null;
  pending: boolean;
}

export interface LeaderboardResponse {
  students: StudentView[];
}

export interface AdminStudentsResponse {
  students: StudentView[];
  pendingStudents: StudentView[];
}

export interface ApiErrorResponse {
  message: string;
}

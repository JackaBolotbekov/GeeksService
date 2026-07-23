export const LESSON_COUNT = 12;

export type StudentStatus = "pending" | "active" | "archived";

export interface ScoreCell {
  lessonNumber: number;
  score: number | null;
  updatedAt: string | null;
}

export interface StudentView {
  id: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: StudentStatus;
  scores: ScoreCell[];
  completedLessons: number;
  totalScore: number;
  lastScoredAt: string | null;
  place: number | null;
  pointsBehindLeader: number;
  isCurrentUser: boolean;
}

export interface SessionIdentity {
  sub: string;
  kind: "telegram";
  telegramUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface AuthResponse {
  sessionToken: string;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
    kind: "telegram";
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

export interface HomeworkSubmitResponse {
  ok: boolean;
  submissionId: string;
  fileName: string | null;
}

export interface TeacherMaterialUploadResponse {
  ok: boolean;
  materialId: string;
  fileName: string;
}

export type TeacherUploadJobPhase =
  | "creating"
  | "uploading"
  | "saving"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface TeacherUploadJob {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  progress: number;
  phase: TeacherUploadJobPhase;
  videoId: string | null;
  videoUrl: string | null;
  errorMessage: string | null;
  updatedAt: string;
  isStale: boolean;
}

export interface TeacherUploadJobResponse {
  job: TeacherUploadJob | null;
}

export interface LessonScheduleInput {
  lessonNumber: number;
  scheduledAt: string;
  courseMonth?: number;
}

export interface LessonScheduleItem {
  lessonNumber: number;
  scheduledAt: string;
  courseMonth: number;
  updatedAt: string | null;
  isCompleted: boolean;
}

export interface LessonScheduleTransfer {
  id: string;
  lessonNumber: number;
  originalScheduledAt: string;
  rescheduledAt: string;
  createdAt: string;
}

export interface ScheduleMonth {
  key: string;
  year: number;
  month: number;
  label: string;
}

export interface ScheduleResponse {
  lessons: LessonScheduleItem[];
  transfers: LessonScheduleTransfer[];
  cancellableTransferId: string | null;
  months: ScheduleMonth[];
  currentLabel: string;
  completedLessonCount: number;
  currentCourseMonth: number;
}

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
  submittedLessonNumbers: number[];
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
  lessonNumber: number;
}

export interface TeacherMaterialUploadResponse {
  ok: boolean;
  materialId: string;
  fileName: string;
}

export interface TeacherMaterialUploadPart {
  partNumber: number;
  size: number;
}

export interface TeacherMaterialUploadSessionResponse {
  sessionId: string;
  fileName: string;
  fileSize: number;
  partSize: number;
  completed: boolean;
  materialId: string | null;
  uploadedParts: TeacherMaterialUploadPart[];
}

export interface TeacherMaterialUploadPartResponse extends TeacherMaterialUploadPart {
  ok: boolean;
}

export type TeacherUploadJobPhase =
  | "creating"
  | "uploading"
  | "finalizing"
  | "paused"
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
  lessonNumber: number;
  courseMonth: number;
  confirmedOffset: number;
  chunkSize: number | null;
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
  diagnostics?: TeacherUploadChunkDiagnostic[];
}

export interface TeacherUploadChunkDiagnostic {
  id: string;
  jobId: string;
  startOffset: number;
  endOffset: number;
  confirmedOffset: number;
  chunkSize: number;
  elapsedMs: number;
  speedBps: number;
  retryCount: number;
  httpStatus: number;
  outcome: "confirmed" | "completed" | "retry" | "status";
  createdAt: string;
}

export interface YouTubeUploadResumeResponse {
  completed: boolean;
  state: "uploading" | "processing" | "done";
  job: TeacherUploadJob;
  video: TeacherLessonVideo | null;
  uploadUrl: string | null;
  accessToken: string | null;
  expiresIn: number | null;
  nextOffset: number;
}

export interface TeacherLessonVideo {
  id: string;
  lessonNumber: number;
  courseMonth: number;
  videoId: string;
  videoUrl: string;
  title: string;
  verifiedAt: string;
  updatedAt: string;
}

export interface YouTubeUploadReconcileResponse {
  recovered: boolean;
  nextOffset: number | null;
  state: "uploading" | "processing" | "done";
  video: TeacherLessonVideo | null;
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
  reason: string | null;
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
  lessonVideos: TeacherLessonVideo[];
  latestVideo: TeacherLessonVideo | null;
}

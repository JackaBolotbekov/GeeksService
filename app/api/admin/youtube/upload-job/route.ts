import { jsonError, requireAdmin } from "@/lib/api";
import {
  cancelTeacherUploadJob,
  currentTeacherUploadJob,
  listTeacherUploadChunkDiagnostics,
  recordTeacherUploadChunkDiagnostic,
  teacherUploadJob,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import { upsertTeacherLessonVideo } from "@/lib/lesson-videos";
import type {
  TeacherUploadChunkDiagnostic,
  TeacherUploadJobPhase,
  TeacherUploadJobResponse,
} from "@/lib/types";

type UpdateJobRequest = {
  jobId?: string;
  progress?: number;
  phase?: Exclude<TeacherUploadJobPhase, "interrupted">;
  videoId?: string | null;
  videoUrl?: string | null;
  errorMessage?: string | null;
  confirmedOffset?: number;
  chunkSize?: number | null;
  diagnostic?: Omit<TeacherUploadChunkDiagnostic, "id" | "jobId" | "createdAt">;
};

const mutablePhases = new Set(["creating", "uploading", "finalizing", "paused", "saving", "done", "error", "cancelled"]);

export async function GET(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const url = new URL(request.url);
  const requestedJobId = url.searchParams.get("jobId");
  const job = requestedJobId
    ? await teacherUploadJob(requestedJobId)
    : await currentTeacherUploadJob();
  const includeDiagnostics = url.searchParams.get("diagnostics") === "1";
  const response: TeacherUploadJobResponse = {
    job,
    diagnostics: includeDiagnostics && job
      ? await listTeacherUploadChunkDiagnostics(job.id)
      : undefined,
  };
  return Response.json(response);
}

export async function PATCH(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const body = await request.json().catch(() => null) as UpdateJobRequest | null;
  if (!body?.jobId) return jsonError("Не указана загрузка");
  if (body.phase && !mutablePhases.has(body.phase)) return jsonError("Некорректный статус загрузки");

  const job = await updateTeacherUploadJob(body.jobId, {
    progress: body.progress,
    phase: body.phase,
    videoId: body.videoId,
    videoUrl: body.videoUrl,
    errorMessage: body.errorMessage,
    confirmedOffset: body.confirmedOffset,
    chunkSize: body.chunkSize,
  });
  if (!job) return jsonError("Загрузка уже закрыта", 409);
  if (body.diagnostic) {
    await recordTeacherUploadChunkDiagnostic(body.jobId, body.diagnostic);
  }
  if (job.videoId && job.videoUrl) {
    await upsertTeacherLessonVideo({
      lessonNumber: job.lessonNumber,
      courseMonth: job.courseMonth,
      videoId: job.videoId,
      videoUrl: job.videoUrl,
      title: job.title,
    });
  }
  return Response.json({ job } satisfies TeacherUploadJobResponse);
}

export async function DELETE(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const body = await request.json().catch(() => null) as { jobId?: string } | null;
  if (!body?.jobId) return jsonError("Не указана загрузка");
  await cancelTeacherUploadJob(body.jobId);
  return Response.json({ ok: true });
}

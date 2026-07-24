import { jsonError, requireAdmin } from "@/lib/api";
import {
  cancelTeacherUploadJob,
  currentTeacherUploadJob,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import { upsertTeacherLessonVideo } from "@/lib/lesson-videos";
import type { TeacherUploadJobPhase, TeacherUploadJobResponse } from "@/lib/types";

type UpdateJobRequest = {
  jobId?: string;
  progress?: number;
  phase?: Exclude<TeacherUploadJobPhase, "interrupted">;
  videoId?: string | null;
  videoUrl?: string | null;
  errorMessage?: string | null;
};

const mutablePhases = new Set(["creating", "uploading", "saving", "done", "error", "cancelled"]);

export async function GET(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const response: TeacherUploadJobResponse = { job: await currentTeacherUploadJob() };
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
  });
  if (!job) return jsonError("Загрузка уже закрыта", 409);
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

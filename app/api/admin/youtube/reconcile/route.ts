import { jsonError, requireAdmin } from "@/lib/api";
import { teacherLessonVideo, upsertTeacherLessonVideo } from "@/lib/lesson-videos";
import {
  latestRecoverableTeacherUploadJob,
  teacherUploadJobInternal,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import type { YouTubeUploadReconcileResponse } from "@/lib/types";
import { exchangeYouTubeRefreshToken } from "@/lib/youtube-oauth";
import {
  findRecentlyUploadedVideo,
  queryYouTubeUploadSession,
  verifyYouTubeVideo,
  YouTubeUploadSessionUnavailableError,
} from "@/lib/youtube-upload-recovery";

type ReconcileRequest = {
  jobId?: string;
  videoId?: string;
  lessonNumber?: number;
  courseMonth?: number;
};

export async function GET(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const url = new URL(request.url);
  const lessonNumber = positiveInteger(Number(url.searchParams.get("lessonNumber")), 1);
  const courseMonth = positiveInteger(Number(url.searchParams.get("courseMonth")), 1);
  const video = await teacherLessonVideo(lessonNumber, courseMonth);
  return Response.json({
    recovered: Boolean(video),
    nextOffset: null,
    state: video ? "done" : "uploading",
    video,
    job: null,
  } satisfies YouTubeUploadReconcileResponse);
}

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const body = await request.json().catch(() => null) as ReconcileRequest | null;
  if (!body) return jsonError("Не указаны данные загрузки");

  try {
    if (body.videoId) return await attachKnownVideo(body);
    if (!body.jobId) return jsonError("Не указана загрузка");
    return await reconcileUploadJob(body.jobId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось восстановить загрузку YouTube", 409);
  }
}

async function attachKnownVideo(body: ReconcileRequest): Promise<Response> {
  const verified = await verifyYouTubeVideo(body.videoId ?? "");
  const lessonNumber = positiveInteger(body.lessonNumber, 1);
  const courseMonth = positiveInteger(body.courseMonth, 1);
  const video = await upsertTeacherLessonVideo({
    lessonNumber,
    courseMonth,
    videoId: verified.videoId,
    videoUrl: verified.videoUrl,
    title: verified.title,
  });
  const matchingJob = await latestRecoverableTeacherUploadJob(verified.title);
  const job = matchingJob
    ? await updateTeacherUploadJob(matchingJob.id, {
      lessonNumber,
      courseMonth,
      phase: "done",
      progress: 100,
      confirmedOffset: matchingJob.fileSize,
      videoId: verified.videoId,
      videoUrl: verified.videoUrl,
      errorMessage: null,
    })
    : null;
  return Response.json({
    recovered: true,
    nextOffset: null,
    state: "done",
    video,
    job,
  } satisfies YouTubeUploadReconcileResponse);
}

async function reconcileUploadJob(jobId: string): Promise<Response> {
  const current = await teacherUploadJobInternal(jobId);
  if (!current) return jsonError("Загрузка не найдена", 404);
  if (current.videoId) {
    const video = await upsertTeacherLessonVideo({
      lessonNumber: current.lessonNumber,
      courseMonth: current.courseMonth,
      videoId: current.videoId,
      videoUrl: current.videoUrl ?? undefined,
      title: current.title,
    });
    return Response.json({
      recovered: true,
      nextOffset: null,
      state: "done",
      video,
      job: current,
    } satisfies YouTubeUploadReconcileResponse);
  }
  if (!current.uploadUrl) return jsonError("У этой загрузки нет сохранённой resumable-сессии", 409);

  const token = await exchangeYouTubeRefreshToken();
  let status;
  try {
    status = await queryYouTubeUploadSession({
      uploadUrl: current.uploadUrl,
      accessToken: token.accessToken,
      fileSize: current.fileSize,
    });
  } catch (error) {
    if (!(error instanceof YouTubeUploadSessionUnavailableError)) throw error;
    const recovered = await findRecentlyUploadedVideo({
      accessToken: token.accessToken,
      title: current.title,
      createdAt: current.createdAt,
      jobId: current.id,
    });
    if (recovered) return completeRecoveredUpload(current, recovered.videoId, recovered.videoUrl);
    return markUploadFinalizing(current);
  }
  if (!status.completed) {
    if (status.nextOffset >= current.fileSize) {
      const recovered = await findRecentlyUploadedVideo({
        accessToken: token.accessToken,
        title: current.title,
        createdAt: current.createdAt,
        jobId: current.id,
      });
      if (recovered) return completeRecoveredUpload(current, recovered.videoId, recovered.videoUrl);
      return markUploadFinalizing(current);
    }
    const progress = Math.min(99, Math.round((status.nextOffset / current.fileSize) * 100));
    const job = await updateTeacherUploadJob(current.id, {
      phase: "uploading",
      progress,
      confirmedOffset: status.nextOffset,
      errorMessage: null,
      allowResume: true,
    });
    return Response.json({
      recovered: false,
      nextOffset: status.nextOffset,
      state: "uploading",
      video: null,
      job,
    } satisfies YouTubeUploadReconcileResponse);
  }

  return completeRecoveredUpload(current, status.videoId, `https://youtu.be/${status.videoId}`);
}

async function completeRecoveredUpload(
  current: NonNullable<Awaited<ReturnType<typeof teacherUploadJobInternal>>>,
  videoId: string,
  videoUrl: string,
): Promise<Response> {
  const video = await upsertTeacherLessonVideo({
    lessonNumber: current.lessonNumber,
    courseMonth: current.courseMonth,
    videoId,
    videoUrl,
    title: current.title,
  });
  const job = await updateTeacherUploadJob(current.id, {
    phase: "done",
    progress: 100,
    confirmedOffset: current.fileSize,
    videoId,
    videoUrl,
    errorMessage: null,
  });
  return Response.json({
    recovered: true,
    nextOffset: null,
    state: "done",
    video,
    job,
  } satisfies YouTubeUploadReconcileResponse);
}

async function markUploadFinalizing(
  current: NonNullable<Awaited<ReturnType<typeof teacherUploadJobInternal>>>,
): Promise<Response> {
  const job = await updateTeacherUploadJob(current.id, {
    phase: "finalizing",
    progress: 100,
    confirmedOffset: current.fileSize,
    errorMessage: null,
  });
  return Response.json({
    recovered: false,
    nextOffset: current.fileSize,
    state: "processing",
    video: null,
    job,
  } satisfies YouTubeUploadReconcileResponse);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

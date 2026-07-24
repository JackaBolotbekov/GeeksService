import { jsonError, requireAdmin } from "@/lib/api";
import { upsertTeacherLessonVideo } from "@/lib/lesson-videos";
import {
  teacherUploadJobInternal,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import type { YouTubeUploadResumeResponse } from "@/lib/types";
import { exchangeYouTubeRefreshToken } from "@/lib/youtube-oauth";
import {
  findRecentlyUploadedVideo,
  queryYouTubeUploadSession,
  YouTubeUploadSessionUnavailableError,
} from "@/lib/youtube-upload-recovery";

type ResumeUploadRequest = {
  jobId?: string;
  fileName?: string;
  fileSize?: number;
};

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const body = await request.json().catch(() => null) as ResumeUploadRequest | null;
  if (!body?.jobId) return jsonError("Не указана загрузка");

  const current = await teacherUploadJobInternal(body.jobId);
  if (!current) return jsonError("Загрузка не найдена", 404);
  if (current.phase === "cancelled") return jsonError("Загрузка уже отменена", 409);
  if (body.fileName !== current.fileName || body.fileSize !== current.fileSize) {
    return jsonError("Для продолжения выбери тот же исходный видеофайл", 409);
  }
  if (!current.uploadUrl) {
    return jsonError("У загрузки нет сохранённой resumable-сессии YouTube", 409);
  }

  try {
    if (current.videoId) {
      const video = await upsertTeacherLessonVideo({
        lessonNumber: current.lessonNumber,
        courseMonth: current.courseMonth,
        videoId: current.videoId,
        videoUrl: current.videoUrl ?? undefined,
        title: current.title,
      });
      return Response.json({
        completed: true,
        state: "done",
        job: current,
        video,
        uploadUrl: null,
        accessToken: null,
        expiresIn: null,
        nextOffset: current.fileSize,
      } satisfies YouTubeUploadResumeResponse);
    }

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
      if (recovered) {
        return completeUpload(current, recovered.videoId, recovered.videoUrl);
      }
      return finalizingUpload(current);
    }
    if (status.completed) {
      return completeUpload(current, status.videoId, `https://youtu.be/${status.videoId}`);
    }
    if (status.nextOffset >= current.fileSize) {
      const recovered = await findRecentlyUploadedVideo({
        accessToken: token.accessToken,
        title: current.title,
        createdAt: current.createdAt,
        jobId: current.id,
      });
      if (recovered) {
        return completeUpload(current, recovered.videoId, recovered.videoUrl);
      }
      return finalizingUpload(current);
    }

    const progress = Math.min(99, Math.round((status.nextOffset / current.fileSize) * 100));
    const job = await updateTeacherUploadJob(current.id, {
      phase: "uploading",
      progress,
      confirmedOffset: status.nextOffset,
      errorMessage: null,
      allowResume: true,
    });
    if (!job) return jsonError("Загрузка уже закрыта", 409);
    return Response.json({
      completed: false,
      state: "uploading",
      job,
      video: null,
      uploadUrl: current.uploadUrl,
      accessToken: token.accessToken,
      expiresIn: token.expiresIn,
      nextOffset: status.nextOffset,
    } satisfies YouTubeUploadResumeResponse);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Не удалось продолжить загрузку YouTube",
      502,
    );
  }
}

async function completeUpload(
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
  if (!job) return jsonError("Загрузка уже закрыта", 409);
  return Response.json({
    completed: true,
    state: "done",
    job,
    video,
    uploadUrl: null,
    accessToken: null,
    expiresIn: null,
    nextOffset: current.fileSize,
  } satisfies YouTubeUploadResumeResponse);
}

async function finalizingUpload(
  current: NonNullable<Awaited<ReturnType<typeof teacherUploadJobInternal>>>,
): Promise<Response> {
  const job = await updateTeacherUploadJob(current.id, {
    phase: "finalizing",
    progress: 100,
    confirmedOffset: current.fileSize,
    errorMessage: null,
  });
  if (!job) return jsonError("Загрузка уже закрыта", 409);
  return Response.json({
    completed: false,
    state: "processing",
    job,
    video: null,
    uploadUrl: null,
    accessToken: null,
    expiresIn: null,
    nextOffset: current.fileSize,
  } satisfies YouTubeUploadResumeResponse);
}

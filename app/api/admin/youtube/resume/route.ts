import { jsonError, requireAdmin } from "@/lib/api";
import { upsertTeacherLessonVideo } from "@/lib/lesson-videos";
import {
  teacherUploadJobInternal,
  updateTeacherUploadJob,
} from "@/lib/upload-jobs";
import type { YouTubeUploadResumeResponse } from "@/lib/types";
import { exchangeYouTubeRefreshToken } from "@/lib/youtube-oauth";
import { queryYouTubeUploadSession } from "@/lib/youtube-upload-recovery";

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
        job: current,
        video,
        uploadUrl: null,
        accessToken: null,
        expiresIn: null,
        nextOffset: current.fileSize,
      } satisfies YouTubeUploadResumeResponse);
    }

    const token = await exchangeYouTubeRefreshToken();
    const status = await queryYouTubeUploadSession({
      uploadUrl: current.uploadUrl,
      accessToken: token.accessToken,
      fileSize: current.fileSize,
    });
    if (status.completed) {
      const videoUrl = `https://youtu.be/${status.videoId}`;
      const video = await upsertTeacherLessonVideo({
        lessonNumber: current.lessonNumber,
        courseMonth: current.courseMonth,
        videoId: status.videoId,
        videoUrl,
        title: current.title,
      });
      const job = await updateTeacherUploadJob(current.id, {
        phase: "done",
        progress: 100,
        confirmedOffset: current.fileSize,
        videoId: status.videoId,
        videoUrl,
        errorMessage: null,
      });
      if (!job) return jsonError("Загрузка уже закрыта", 409);
      return Response.json({
        completed: true,
        job,
        video,
        uploadUrl: null,
        accessToken: null,
        expiresIn: null,
        nextOffset: current.fileSize,
      } satisfies YouTubeUploadResumeResponse);
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

"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { lessonHomeworkByNumber, type LessonHomework } from "@/lib/lesson-homework";
import { validateTeacherMaterialFile } from "@/lib/material-validation";
import { bishkekDateKey, buildScheduleResponse, defaultTransferTarget, DEFAULT_LESSON_SCHEDULE, localDateParts, transferLessonSchedule } from "@/lib/schedule";
import type { AdminStudentsResponse, AuthResponse, HomeworkSubmitResponse, LeaderboardResponse, LessonScheduleInput, LessonScheduleItem, LessonScheduleTransfer, MeResponse, ScheduleResponse, StudentView, TeacherMaterialUploadPartResponse, TeacherMaterialUploadResponse, TeacherMaterialUploadSessionResponse, TeacherUploadChunkDiagnostic, TeacherUploadJob, TeacherUploadJobResponse, YouTubeUploadReconcileResponse, YouTubeUploadResumeResponse } from "@/lib/types";
import {
  initialYouTubeUploadChunkSize,
  isRetriableYouTubeUploadStatus,
  nextYouTubeUploadOffset,
} from "@/lib/youtube-resumable";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type LoadState = "loading" | "ready" | "error";
type ActiveScreen = "leaderboard" | "homeworkUpload" | "profile";
type UploadPhase = "idle" | "creating" | "uploading" | "finalizing" | "paused" | "saving" | "done" | "error";
type HomeworkSubmitPhase = "idle" | "submitting" | "done" | "error";
type TestRole = "service" | "students" | "teachers";

const TEST_ROLE_ORDER: TestRole[] = ["service", "students", "teachers"];
const TEST_ROLE_LABELS: Record<TestRole, string> = {
  service: "SERVICE",
  students: "STUDENTS",
  teachers: "TEACHERS",
};

type YouTubeUploadSessionResponse = {
  reused: boolean;
  uploadUrl: string | null;
  accessToken: string | null;
  expiresIn: number | null;
  privacyStatus: "private" | "public" | "unlisted";
  jobId: string;
};

type YouTubeAccessTokenResponse = {
  accessToken: string;
  expiresIn: number;
};

type TelegramWebApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
    selectionChanged?: () => void;
  };
};

type StudentPatch = {
  displayName?: string;
  telegramUsername?: string | null;
  telegramUserId?: string | null;
  avatarUrl?: string | null;
};

type StudentDraft = {
  displayName: string;
  telegram: string;
};

type StudentChange = {
  student: StudentView;
  patch: StudentPatch;
};

type EditField = keyof StudentDraft;

type UploadChunkInput = {
  uploadUrl: string;
  accessToken: string;
  chunk: Blob;
  start: number;
  end: number;
  total: number;
  mimeType: string;
  onProgress: (loaded: number) => void;
};

type UploadChunkDiagnosticInput = Omit<
  TeacherUploadChunkDiagnostic,
  "id" | "jobId" | "createdAt"
>;

const VIDEO_UPLOAD_RETRIES = 6;
const VIDEO_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MATERIAL_UPLOAD_RETRIES = 4;
const LEADERBOARD_CACHE_KEY = "geeks-service:leaderboard:v1";
const LEADERBOARD_LIVE_INTERVAL_MS = 1400;
const TEACHER_UPLOAD_DRAFT_KEY = "geeks-service:teacher-upload-draft:v1";
const UPLOAD_JOB_POLL_INTERVAL_MS = 1600;

async function api<T>(path: string, options: RequestInit = {}, sessionToken?: string): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? "Ошибка запроса");
  return data as T;
}

async function apiForm<T>(path: string, body: FormData, sessionToken?: string | null): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? "Ошибка запроса");
  return data as T;
}

async function apiBinary<T>(
  path: string,
  body: Blob,
  sessionToken: string,
): Promise<T> {
  const response = await fetch(path, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? "Ошибка загрузки части файла");
  return data as T;
}

async function waitForTelegramWebApp(timeoutMs = 1200): Promise<TelegramWebApp | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const webApp = window.Telegram?.WebApp;
    if (webApp) return webApp;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return window.Telegram?.WebApp;
}

function hapticSelection() {
  window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
}

function hapticImpact(style: "light" | "medium" | "heavy" | "rigid" | "soft" = "light") {
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.(style);
}

function hapticNotice(type: "error" | "success" | "warning") {
  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.(type);
}

function readCachedLeaderboard(): StudentView[] | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = window.localStorage.getItem(LEADERBOARD_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as { students?: StudentView[] };
    return Array.isArray(parsed.students) ? parsed.students : null;
  } catch {
    return null;
  }
}

function writeCachedLeaderboard(students: StudentView[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify({ students, cachedAt: Date.now() }));
  } catch {
    // Best-effort cache only; the server remains the source of truth.
  }
}

function leaderboardSignature(students: StudentView[]): string {
  return students.map((student) => [
    student.id,
    student.place,
    student.displayName,
    student.telegramUsername ?? "",
    student.telegramUserId ?? "",
    student.avatarUrl ?? "",
    student.completedLessons,
    student.totalScore,
    student.lastScoredAt ?? "",
    student.scores.map((cell) => `${cell.lessonNumber}:${cell.score ?? "-"}:${cell.updatedAt ?? ""}`).join(","),
  ].join("~")).join("|");
}

function isSameLeaderboard(left: StudentView[], right: StudentView[]): boolean {
  return leaderboardSignature(left) === leaderboardSignature(right);
}

function homeworkLinksAreValid(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return trimmed
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((token) =>
      /^(https?:\/\/|www\.)\S+$/i.test(token)
      || /^@[a-z0-9_]{3,32}$/i.test(token)
      || /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(token),
    );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function fileTitle(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").trim();
}

function readTeacherUploadDraft(): { title?: string; description?: string } {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(TEACHER_UPLOAD_DRAFT_KEY) ?? "{}") as {
      title?: unknown;
      description?: unknown;
    };
    return {
      title: typeof value.title === "string" ? value.title : undefined,
      description: typeof value.description === "string" ? value.description : undefined,
    };
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function uploadJobStatusLabel(job: TeacherUploadJob): string {
  if (job.phase === "interrupted") return "Загрузка остановилась на устройстве";
  if (job.phase === "paused") return "Загрузка приостановлена";
  if (job.phase === "finalizing") return "YouTube обрабатывает видео";
  if (job.phase === "creating") return "Готовится загрузка";
  if (job.phase === "saving") return "Сохраняется допматериал";
  return "Видео загружается в YouTube";
}

function preferredYouTubeUploadChunkSize(fileSize: number): number {
  const connection = (
    navigator as Navigator & {
      connection?: { downlink?: number; effectiveType?: string };
    }
  ).connection;
  return Math.min(
    fileSize,
    initialYouTubeUploadChunkSize(connection?.downlink, connection?.effectiveType),
  );
}

async function uploadFileToYouTube({
  file,
  uploadUrl,
  accessToken,
  refreshAccessToken,
  reconcileUpload,
  onProgress,
  onDiagnostic,
  startOffset = 0,
  chunkSize: suppliedChunkSize,
}: {
  file: File;
  uploadUrl: string;
  accessToken: string;
  refreshAccessToken: () => Promise<string>;
  reconcileUpload: () => Promise<{
    videoId: string | null;
    nextOffset: number | null;
    state: "uploading" | "processing" | "done";
  }>;
  onProgress: (progress: number) => void;
  onDiagnostic: (diagnostic: UploadChunkDiagnosticInput) => Promise<void>;
  startOffset?: number;
  chunkSize?: number | null;
}): Promise<string> {
  if (file.size <= 0) throw new Error("Видео пустое");

  let offset = Math.max(0, Math.min(file.size, Math.round(startOffset)));
  let videoId: string | null = null;
  let currentAccessToken = accessToken;
  let retry = 0;
  const chunkSize = suppliedChunkSize && suppliedChunkSize > 0
    ? Math.min(file.size, suppliedChunkSize)
    : preferredYouTubeUploadChunkSize(file.size);

  while (offset < file.size) {
    const chunkStart = offset;
    const end = Math.min(chunkStart + chunkSize, file.size);
    const chunk = file.slice(chunkStart, end, file.type || "application/octet-stream");
    const startedAt = performance.now();
    try {
      const result = await uploadYouTubeChunk({
        uploadUrl,
        accessToken: currentAccessToken,
        chunk,
        start: chunkStart,
        end,
        total: file.size,
        mimeType: file.type || "application/octet-stream",
        onProgress: (loaded) => onProgress(Math.min(99, Math.round(((chunkStart + loaded) / file.size) * 100))),
      });
      offset = result.nextOffset;
      if (result.videoId) videoId = result.videoId;
      const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
      await onDiagnostic({
        startOffset: chunkStart,
        endOffset: end,
        confirmedOffset: offset,
        chunkSize,
        elapsedMs,
        speedBps: Math.round(((offset - chunkStart) * 1000) / elapsedMs),
        retryCount: retry,
        httpStatus: result.httpStatus,
        outcome: result.videoId ? "completed" : "confirmed",
      }).catch(() => undefined);
      retry = 0;
    } catch (error) {
      const status = uploadErrorStatus(error);
      const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
      await onDiagnostic({
        startOffset: chunkStart,
        endOffset: end,
        confirmedOffset: offset,
        chunkSize,
        elapsedMs,
        speedBps: 0,
        retryCount: retry + 1,
        httpStatus: status,
        outcome: "retry",
      }).catch(() => undefined);
      if (status === 401) {
        currentAccessToken = await refreshAccessToken();
        continue;
      }
      if (!isRetriableYouTubeUploadStatus(status)) throw error;
      if (retry >= VIDEO_UPLOAD_RETRIES) {
        const reconciled = await reconcileUpload().catch(() => ({
          videoId: null,
          nextOffset: null,
          state: "uploading" as const,
        }));
        if (reconciled.videoId) {
          onProgress(100);
          return reconciled.videoId;
        }
        offset = reconciled.nextOffset === null
          ? offset
          : Math.max(offset, Math.min(file.size, reconciled.nextOffset));
        if (offset >= file.size || reconciled.state === "processing") {
          throw createFinalizingUploadError(file.size, chunkSize);
        }
        throw createPausedUploadError(offset, chunkSize, status);
      }

      await uploadRetryDelay(retry);
      retry += 1;
      try {
        const recovered = await queryYouTubeUploadStatus({
          uploadUrl,
          accessToken: currentAccessToken,
          total: file.size,
        });
        await onDiagnostic({
          startOffset: chunkStart,
          endOffset: end,
          confirmedOffset: recovered.nextOffset,
          chunkSize,
          elapsedMs: 0,
          speedBps: 0,
          retryCount: retry,
          httpStatus: recovered.httpStatus,
          outcome: "status",
        }).catch(() => undefined);
        if (recovered.videoId) return recovered.videoId;
        if (recovered.nextOffset > offset) {
          offset = recovered.nextOffset;
          retry = 0;
          onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
        }
      } catch (statusError) {
        const statusCode = uploadErrorStatus(statusError);
        if (statusCode === 401) {
          currentAccessToken = await refreshAccessToken();
          continue;
        }
        if ((statusCode === 404 || statusCode === 410) && end === file.size) {
          const reconciled = await reconcileUpload().catch(() => ({
            videoId: null,
            nextOffset: file.size,
            state: "processing" as const,
          }));
          if (reconciled.videoId) return reconciled.videoId;
          if (reconciled.nextOffset !== null && reconciled.nextOffset < file.size) {
            offset = reconciled.nextOffset;
            retry = 0;
            continue;
          }
          throw createFinalizingUploadError(file.size, chunkSize);
        }
        if (!isRetriableYouTubeUploadStatus(statusCode)) throw statusError;
      }
    }
  }

  onProgress(100);
  if (!videoId) {
    const reconciled = await reconcileUpload().catch((
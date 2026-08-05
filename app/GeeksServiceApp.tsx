"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { lessonHomeworkByNumber, type LessonHomework } from "@/lib/lesson-homework";
import { validateTeacherMaterialFile } from "@/lib/material-validation";
import { bishkekDateKey, buildScheduleResponse, defaultTransferTarget, DEFAULT_LESSON_SCHEDULE, localDateParts, transferLessonSchedule } from "@/lib/schedule";
import type { AdminStudentsResponse, AuthResponse, HomeworkSubmitResponse, LeaderboardResponse, LessonScheduleInput, LessonScheduleItem, LessonScheduleTransfer, MeResponse, ScheduleResponse, StudentView, TeacherLessonVideo, TeacherMaterialUploadPartResponse, TeacherMaterialUploadResponse, TeacherMaterialUploadSessionResponse, TeacherUploadChunkDiagnostic, TeacherUploadJob, TeacherUploadJobResponse, YouTubeUploadReconcileResponse, YouTubeUploadResumeResponse } from "@/lib/types";
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
    const reconciled = await reconcileUpload().catch(() => ({
      videoId: null,
      nextOffset: file.size,
      state: "processing" as const,
    }));
    videoId = reconciled.videoId;
    if (!videoId && reconciled.nextOffset !== null && reconciled.nextOffset < file.size) {
      return uploadFileToYouTube({
        file,
        uploadUrl,
        accessToken: currentAccessToken,
        refreshAccessToken,
        reconcileUpload,
        onProgress,
        onDiagnostic,
        startOffset: reconciled.nextOffset,
        chunkSize,
      });
    }
  }
  if (!videoId) throw createFinalizingUploadError(file.size, chunkSize);
  return videoId;
}

type FinalizingUploadError = Error & {
  finalizing: true;
  nextOffset: number;
  chunkSize: number;
};

function createFinalizingUploadError(
  nextOffset: number,
  chunkSize: number,
): FinalizingUploadError {
  const error = new Error(
    "Файл уже передан. Ожидаю подтверждение и обработку YouTube — повторно видео не загружается.",
  ) as FinalizingUploadError;
  error.finalizing = true;
  error.nextOffset = nextOffset;
  error.chunkSize = chunkSize;
  return error;
}

function isFinalizingUploadError(error: unknown): error is FinalizingUploadError {
  return error instanceof Error
    && "finalizing" in error
    && (error as { finalizing?: unknown }).finalizing === true;
}

type PausedUploadError = Error & {
  paused: true;
  nextOffset: number;
  chunkSize: number;
  status: number;
};

function createPausedUploadError(
  nextOffset: number,
  chunkSize: number,
  status: number,
): PausedUploadError {
  const error = new Error(
    "Загрузка приостановлена. Она продолжится с подтверждённого места после восстановления интернета.",
  ) as PausedUploadError;
  error.paused = true;
  error.nextOffset = nextOffset;
  error.chunkSize = chunkSize;
  error.status = status;
  return error;
}

function isPausedUploadError(error: unknown): error is PausedUploadError {
  return error instanceof Error
    && "paused" in error
    && (error as { paused?: unknown }).paused === true;
}

function uploadErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: number }).status)
    : 0;
}

async function uploadRetryDelay(attempt: number): Promise<void> {
  const delay = Math.min(8000, 700 * 2 ** attempt) + Math.round(Math.random() * 350);
  await sleep(delay);
}

function uploadYouTubeChunk({
  uploadUrl,
  accessToken,
  chunk,
  start,
  end,
  total,
  mimeType,
  onProgress,
}: UploadChunkInput): Promise<{ videoId: string | null; nextOffset: number; httpStatus: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = VIDEO_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${end - 1}/${total}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onerror = () => {
      reject(createUploadError("Не удалось загрузить часть видео в YouTube", 0));
    };
    xhr.ontimeout = () => {
      reject(createUploadError("YouTube слишком долго не отвечал", 0));
    };
    xhr.onload = () => {
      if (xhr.status === 308) {
        resolve({
          videoId: null,
          nextOffset: nextYouTubeUploadOffset(xhr.getResponseHeader("Range"), end),
          httpStatus: xhr.status,
        });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || "{}") as { id?: string };
          resolve({ videoId: data.id ?? null, nextOffset: end, httpStatus: xhr.status });
        } catch {
          reject(new Error("YouTube вернул некорректный ответ после загрузки"));
        }
        return;
      }
      reject(createUploadError(`YouTube upload error ${xhr.status}`, xhr.status));
    };
    xhr.send(chunk);
  });
}

function queryYouTubeUploadStatus({
  uploadUrl,
  accessToken,
  total,
}: {
  uploadUrl: string;
  accessToken: string;
  total: number;
}): Promise<{ videoId: string | null; nextOffset: number; httpStatus: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = VIDEO_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);
    xhr.onerror = () => reject(createUploadError("Не удалось проверить состояние загрузки YouTube", 0));
    xhr.ontimeout = () => reject(createUploadError("YouTube слишком долго не отвечал", 0));
    xhr.onload = () => {
      if (xhr.status === 308) {
        resolve({
          videoId: null,
          nextOffset: nextYouTubeUploadOffset(xhr.getResponseHeader("Range"), 0),
          httpStatus: xhr.status,
        });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || "{}") as { id?: string };
          resolve({ videoId: data.id ?? null, nextOffset: total, httpStatus: xhr.status });
        } catch {
          reject(createUploadError("YouTube вернул некорректный статус загрузки", xhr.status));
        }
        return;
      }
      reject(createUploadError(`YouTube status error ${xhr.status}`, xhr.status));
    };
    xhr.send();
  });
}

function createUploadError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function useLockedViewportZoom() {
  useEffect(() => {
    const options: AddEventListenerOptions = { passive: false };
    const preventZoomGesture: EventListener = (event) => {
      event.preventDefault();
    };
    const preventKeyboardZoom = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (["+", "=", "-", "_", "0"].includes(event.key)) event.preventDefault();
    };
    let lastTouchEnd = 0;
    const preventDoubleTapZoom = (event: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd < 350) event.preventDefault();
      lastTouchEnd = now;
    };

    document.addEventListener("gesturestart", preventZoomGesture, options);
    document.addEventListener("gesturechange", preventZoomGesture, options);
    document.addEventListener("gestureend", preventZoomGesture, options);
    document.addEventListener("keydown", preventKeyboardZoom, options);
    document.addEventListener("touchend", preventDoubleTapZoom, options);
    document.addEventListener("dblclick", preventZoomGesture, options);

    return () => {
      document.removeEventListener("gesturestart", preventZoomGesture);
      document.removeEventListener("gesturechange", preventZoomGesture);
      document.removeEventListener("gestureend", preventZoomGesture);
      document.removeEventListener("keydown", preventKeyboardZoom);
      document.removeEventListener("touchend", preventDoubleTapZoom);
      document.removeEventListener("dblclick", preventZoomGesture);
    };
  }, []);
}

function focusEditableFieldEnd(input: HTMLInputElement) {
  window.requestAnimationFrame(() => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
    input.scrollLeft = input.scrollWidth;
  });
}

function rankVisibleStudents(students: StudentView[]): StudentView[] {
  const activeStudents = students
    .filter((student) => student.status === "active")
    .sort((left, right) =>
      right.totalScore - left.totalScore
      || compareScoreTime(left.lastScoredAt, right.lastScoredAt)
      || right.completedLessons - left.completedLessons
      || left.displayName.localeCompare(right.displayName, "ru"),
    );
  const leaderScore = activeStudents[0]?.totalScore ?? 0;
  return activeStudents.map((student, index) => ({
    ...student,
    place: index + 1,
    pointsBehindLeader: Math.max(0, leaderScore - student.totalScore),
  }));
}

function compareScoreTime(left: string | null, right: string | null): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function lastScoredAt(scores: StudentView["scores"]): string | null {
  return scores.reduce<string | null>((latest, cell) => {
    if (cell.score === null || !cell.updatedAt) return latest;
    return !latest || cell.updatedAt > latest ? cell.updatedAt : latest;
  }, null);
}

function withScore(students: StudentView[], studentId: string, lessonNumber: number, score: number | null): StudentView[] {
  const updatedAt = new Date().toISOString();
  return rankVisibleStudents(students.map((student) => {
    if (student.id !== studentId) return student;
    const scores = student.scores.map((cell) =>
      cell.lessonNumber === lessonNumber
        ? { ...cell, score, updatedAt: score === null ? null : updatedAt }
        : cell,
    );
    return {
      ...student,
      scores,
      completedLessons: scores.filter((cell) => cell.score !== null).length,
      totalScore: scores.reduce((sum, cell) => sum + (cell.score ?? 0), 0),
      lastScoredAt: lastScoredAt(scores),
    };
  }));
}

function homeworkLabel(completedLessons: number) {
  return completedLessons === 12 ? "12 из 12 ✅" : `${completedLessons} из 12 ДЗ`;
}

function normalizeUsernameInput(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/^@/, "").toLowerCase();
  return cleaned || null;
}

function publicTelegramAvatarUrl(username: string | null | undefined): string | null {
  const normalized = normalizeUsernameInput(username);
  return normalized ? `https://t.me/i/userpic/320/${encodeURIComponent(normalized)}.jpg` : null;
}

function telegramDraftValue(student: StudentView): string {
  if (student.telegramUsername) return `@${student.telegramUsername}`;
  return student.telegramUserId ?? "";
}

function isTelegramId(value: string): boolean {
  return /^\d{1,20}$/.test(value.trim());
}

function buildStudentPatch(student: StudentView, draft: StudentDraft): StudentPatch | null {
  const displayName = draft.displayName.trim();
  const telegram = draft.telegram.trim();
  if (!displayName) throw new Error("Имя ученика обязательно");

  const patch: StudentPatch = {};
  if (displayName !== student.displayName) patch.displayName = displayName;

  if (telegram !== telegramDraftValue(student)) {
    if (!telegram) {
      patch.telegramUserId = null;
      patch.telegramUsername = null;
      patch.avatarUrl = null;
    } else if (isTelegramId(telegram)) {
      patch.telegramUserId = telegram;
      if (student.telegramUsername) {
        patch.telegramUsername = null;
        patch.avatarUrl = null;
      }
    } else {
      const telegramUsername = normalizeUsernameInput(telegram);
      patch.telegramUsername = telegramUsername;
      patch.avatarUrl = publicTelegramAvatarUrl(telegramUsername);
    }
  }

  return Object.keys(patch).length ? patch : null;
}

function mergeStudentPatch(student: StudentView, patch: StudentPatch): StudentView {
  const nextUsername = patch.telegramUsername === undefined
    ? student.telegramUsername
    : normalizeUsernameInput(patch.telegramUsername);
  const nextAvatarUrl = patch.avatarUrl === undefined
    ? (nextUsername && nextUsername !== student.telegramUsername ? publicTelegramAvatarUrl(nextUsername) : student.avatarUrl)
    : patch.avatarUrl;

  return {
    ...student,
    displayName: patch.displayName ?? student.displayName,
    telegramUsername: nextUsername,
    telegramUserId: patch.telegramUserId === undefined ? student.telegramUserId : patch.telegramUserId,
    avatarUrl: nextAvatarUrl,
  };
}

function ScheduleBadge({ label }: { label: string }) {
  const labels = ["VibeCoding 1", label];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % labels.length);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [labels.length]);

  const activeLabel = labels[index] ?? label;

  return (
    <span className="groupBadge" aria-label="Текущий учебный прогресс">
      <span className="groupBadgeText" key={activeLabel}>{activeLabel}</span>
    </span>
  );
}

export function GeeksServiceApp({ initialStudents }: { initialStudents: StudentView[] }) {
  useLockedViewportZoom();

  const [state, setState] = useState<LoadState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [rolePreviewAvailable, setRolePreviewAvailable] = useState(false);
  const [testRole, setTestRole] = useState<TestRole>("service");
  const [currentStudent, setCurrentStudent] = useState<StudentView | null>(null);
  const [submittedLessonNumbers, setSubmittedLessonNumbers] = useState<number[]>([]);
  const [homeworkLessonNumber, setHomeworkLessonNumber] = useState<number | null>(null);
  const [leaderboard, setLeaderboard] = useState<StudentView[]>(() => {
    const rankedInitial = rankVisibleStudents(initialStudents);
    if (rankedInitial.length > 0) return rankedInitial;
    return readCachedLeaderboard() ?? rankedInitial;
  });
  const [schedule, setSchedule] = useState<ScheduleResponse>(() => buildScheduleResponse(DEFAULT_LESSON_SCHEDULE));
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>("leaderboard");
  const leaderboardRef = useRef(leaderboard);
  const teacherPreview = rolePreviewAvailable && testRole === "teachers";
  const studentPreview = rolePreviewAvailable && testRole === "students";
  const actualAdmin = Boolean(isAdmin && sessionToken);
  const effectiveAdmin = rolePreviewAvailable ? teacherPreview : actualAdmin;
  const canOpenHomework = rolePreviewAvailable
    ? teacherPreview || studentPreview
    : Boolean(sessionToken && (isAdmin || currentStudent?.status === "active"));
  const visibleScreen = activeScreen === "homeworkUpload" && !canOpenHomework ? "leaderboard" : activeScreen;

  useEffect(() => {
    leaderboardRef.current = leaderboard;
  }, [leaderboard]);

  const setLeaderboardSmooth = (next: StudentView[] | ((current: StudentView[]) => StudentView[])) => {
    setLeaderboard((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      writeCachedLeaderboard(resolved);
      return resolved;
    });
  };

  const setLeaderboardFast = (next: StudentView[] | ((current: StudentView[]) => StudentView[])) => {
    setLeaderboard((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      writeCachedLeaderboard(resolved);
      return resolved;
    });
  };

  const applyAdminResponse = (next: AdminStudentsResponse) => {
    setLeaderboardSmooth(rankVisibleStudents(next.students));
  };

  const refresh = async (token = sessionToken, admin = isAdmin) => {
    if (admin && token) {
      const response = await api<AdminStudentsResponse>("/api/admin/students", {}, token);
      setLeaderboardSmooth(rankVisibleStudents(response.students));
      return;
    }
    const response = await api<LeaderboardResponse>("/api/leaderboard");
    setLeaderboardSmooth(rankVisibleStudents(response.students));
  };

  const refreshSchedule = async () => {
    try {
      const response = await api<ScheduleResponse>("/api/schedule");
      setSchedule(response);
      setScheduleError(null);
    } catch (caught) {
      setScheduleError(caught instanceof Error ? caught.message : "Не удалось загрузить календарь");
    }
  };

  const toggleStudent = (studentId: string) => {
    hapticSelection();
    setExpandedStudentId((current) => current === studentId ? null : studentId);
  };

  const updateStudentOnServer = async (student: StudentView, patch: StudentPatch, token: string): Promise<AdminStudentsResponse> => {
    const nextStudent = mergeStudentPatch(student, patch);
    const body = {
      ...patch,
      ...(patch.telegramUsername !== undefined && nextStudent.telegramUsername ? { avatarUrl: publicTelegramAvatarUrl(nextStudent.telegramUsername) } : {}),
    };
    return api<AdminStudentsResponse>(`/api/admin/students/${student.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }, token);
  };

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refreshSchedule();
    }, 0);
    const timer = window.setInterval(() => {
      setSchedule((current) => buildScheduleResponse(
        current.lessons.length > 0 ? current.lessons : DEFAULT_LESSON_SCHEDULE,
        new Date(),
        current.transfers,
        current.lessonVideos,
      ));
    }, 30000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (state !== "ready" || activeScreen !== "profile" || teacherPreview) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await api<ScheduleResponse>("/api/schedule");
        if (!cancelled) {
          setSchedule(response);
          setScheduleError(null);
        }
      } catch {
        // Keep the current calendar visible and retry on the next tick.
      } finally {
        inFlight = false;
      }
    };
    const delayed = window.setTimeout(() => void tick(), 250);
    const timer = window.setInterval(() => void tick(), 4000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(delayed);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeScreen, state, teacherPreview]);

  useEffect(() => {
    if (state !== "ready" || activeScreen !== "leaderboard") return;
    if (teacherPreview) return;
    let cancelled = false;
    let inFlight = false;
    const applyLiveLeaderboard = (students: StudentView[]) => {
      const ranked = rankVisibleStudents(students);
      if (!isSameLeaderboard(leaderboardRef.current, ranked)) {
        setLeaderboard(() => {
          writeCachedLeaderboard(ranked);
          return ranked;
        });
      }
    };
    const refreshLiveLeaderboard = async () => {
      if (isAdmin && sessionToken) {
        const response = await api<AdminStudentsResponse>("/api/admin/students", {}, sessionToken);
        applyLiveLeaderboard(response.students);
        return;
      }
      const response = await api<LeaderboardResponse>("/api/leaderboard");
      applyLiveLeaderboard(response.students);
    };
    const tick = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        await refreshLiveLeaderboard();
      } catch {
        // Keep the visible leaderboard stable; the next tick will retry.
      } finally {
        inFlight = false;
      }
    };
    const delayed = window.setTimeout(() => {
      void tick();
    }, 250);
    const timer = window.setInterval(() => {
      void tick();
    }, LEADERBOARD_LIVE_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(delayed);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeScreen, isAdmin, sessionToken, state, teacherPreview]);

  useEffect(() => {
    const run = async () => {
      try {
        const telegramWebApp = await waitForTelegramWebApp();
        telegramWebApp?.ready?.();
        telegramWebApp?.expand?.();
        const initData = telegramWebApp?.initData;
        if (initData) {
          setRolePreviewAvailable(false);
          const auth = await api<AuthResponse>("/api/auth/telegram", {
            method: "POST",
            body: JSON.stringify({ initData }),
          });
          setSessionToken(auth.sessionToken);
          setIsAdmin(auth.profile.isAdmin);
          const me = await api<MeResponse>("/api/me", {}, auth.sessionToken);
          setCurrentStudent(me.student);
          setIsPending(me.pending);
          setSubmittedLessonNumbers(me.submittedLessonNumbers);
          await refresh(auth.sessionToken, auth.profile.isAdmin);
        } else {
          setRolePreviewAvailable(true);
          setCurrentStudent(null);
          setIsPending(false);
          setSubmittedLessonNumbers([]);
          await refresh(null, false);
        }
        setState("ready");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Не удалось загрузить Geeks Service");
        setState("error");
      }
    };
    void run();
    // Telegram initData is captured once on Mini App startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cycleTestRole = () => {
    if (!rolePreviewAvailable) return;
    hapticSelection();
    setTestRole((current) => TEST_ROLE_ORDER[(TEST_ROLE_ORDER.indexOf(current) + 1) % TEST_ROLE_ORDER.length]);
    setActiveScreen("leaderboard");
    setShowAdminPanel(false);
    setBulkEditMode(false);
    setExpandedStudentId(null);
  };

  return (
    <main className="shell">
      <header className={`topbar ${teacherPreview ? "previewTeacher" : ""}`}>
        <div className="brand">
          <img className="bolt" src="/geeks-lightning.svg" alt="" />
          {rolePreviewAvailable ? (
            <button
              type="button"
              className="brandRoleSwitcher"
              aria-label={`Тестовая роль: ${TEST_ROLE_LABELS[testRole]}. Переключить роль`}
              onClick={cycleTestRole}
            >
              GEEKS<span key={testRole}>{TEST_ROLE_LABELS[testRole]}</span>
            </button>
          ) : (
            <span>GEEKS<span>SERVICE</span></span>
          )}
        </div>
        <div className="topActions">
          <ScheduleBadge label={schedule.currentLabel} />
          {effectiveAdmin && (
            <>
              <button
                type="button"
                className="editToggle"
                aria-label={bulkEditMode ? "Закрыть редактирование учеников" : "Редактировать учеников"}
                aria-pressed={bulkEditMode}
                onClick={() => {
                  hapticImpact("light");
                  setBulkEditMode((current) => !current);
                  setShowAdminPanel(false);
                  setExpandedStudentId(null);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="addToggle"
                aria-label={showAdminPanel ? "Скрыть добавление ученика" : "Добавить ученика"}
                aria-expanded={showAdminPanel}
                onClick={() => {
                  hapticImpact("light");
                  setShowAdminPanel((current) => !current);
                  setBulkEditMode(false);
                  setExpandedStudentId(null);
                }}
              >
                +
              </button>
            </>
          )}
        </div>
      </header>

      {state === "loading" && <Panel text="Загружаю рейтинг..." />}
      {state === "error" && <Panel text={error ?? "Ошибка"} />}
      {isPending && <Panel text="Заявка отправлена. Админ скоро добавит тебя в активный список." />}

      {state === "ready" && (
        <>
          {canOpenHomework && (
            <div
              className="screenKeepAlive"
              hidden={visibleScreen !== "homeworkUpload"}
              aria-hidden={visibleScreen !== "homeworkUpload"}
            >
              <HomeworkUploadScreen
                isAdmin={effectiveAdmin}
                sessionToken={sessionToken}
                previewRole={rolePreviewAvailable ? testRole : null}
                defaultVideoTitle={`VibeCoding 1 | Урок ${homeworkLessonNumber ?? Math.max(1, schedule.completedLessonCount)} Месяц ${schedule.currentCourseMonth}`}
                lessonNumber={homeworkLessonNumber ?? Math.max(1, schedule.completedLessonCount)}
                courseMonth={schedule.currentCourseMonth}
                latestVideo={schedule.latestVideo}
                onVideoUploaded={() => {
                  void refreshSchedule();
                }}
                onHomeworkSubmitted={(lessonNumber) => {
                  setSubmittedLessonNumbers((current) => (
                    current.includes(lessonNumber) ? current : [...current, lessonNumber].sort((a, b) => a - b)
                  ));
                }}
              />
            </div>
          )}
          {visibleScreen === "profile" ? (
            <ProfileScreen
              schedule={schedule}
              scheduleError={scheduleError}
              isAdmin={effectiveAdmin}
              canViewHomework={canOpenHomework}
              sessionToken={sessionToken}
              previewMode={teacherPreview}
              submittedLessonNumbers={submittedLessonNumbers}
              onSubmitHomework={(lessonNumber) => {
                setHomeworkLessonNumber(lessonNumber);
                setActiveScreen("homeworkUpload");
              }}
              onScheduleChange={(next) => {
                setSchedule(next);
                setScheduleError(null);
              }}
            />
          ) : visibleScreen === "leaderboard" ? (
            <>
              {effectiveAdmin && showAdminPanel && (
                <AdminPanel
                  sessionToken={sessionToken}
                  previewMode={teacherPreview}
                  previewStudents={leaderboard}
                  onChange={applyAdminResponse}
                />
              )}
              <Leaderboard
                students={leaderboard}
                isAdmin={effectiveAdmin}
                expandedStudentId={expandedStudentId}
                bulkEditMode={bulkEditMode}
                onBulkEditClose={() => {
                  setBulkEditMode(false);
                }}
                onToggleStudent={toggleStudent}
                onScoreChange={async (student, lessonNumber, score) => {
                  if (teacherPreview) {
                    setLeaderboardFast((current) => withScore(current, student.id, lessonNumber, score));
                    return;
                  }
                  if (!sessionToken) return;
                  const previous = leaderboardRef.current;
                  setLeaderboardFast((current) => withScore(current, student.id, lessonNumber, score));
                  try {
                    const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}/scores/${lessonNumber}`, {
                      method: "PUT",
                      body: JSON.stringify({ score }),
                    }, sessionToken);
                    setLeaderboardFast(rankVisibleStudents(response.students));
                  } catch (caught) {
                    setLeaderboardFast(previous);
                    throw caught;
                  }
                }}
                onBulkStudentChange={async (changes) => {
                  if (changes.length === 0) return;
                  const previous = leaderboardRef.current;
                  setLeaderboardSmooth((current) => {
                    const patchesById = new Map(changes.map((change) => [change.student.id, change.patch]));
                    return rankVisibleStudents(current.map((item) => {
                      const patch = patchesById.get(item.id);
                      return patch ? mergeStudentPatch(item, patch) : item;
                    }));
                  });
                  if (teacherPreview) return;
                  if (!sessionToken) return;
                  try {
                    let latest: AdminStudentsResponse | null = null;
                    for (const change of changes) {
                      latest = await updateStudentOnServer(change.student, change.patch, sessionToken);
                    }
                    if (latest) applyAdminResponse(latest);
                  } catch (caught) {
                    setLeaderboardSmooth(previous);
                    throw caught;
                  }
                }}
              />
            </>
          ) : null}
          <BottomNav
            activeScreen={visibleScreen}
            canOpenHomework={canOpenHomework}
            onLeaderboard={() => {
              hapticSelection();
              setActiveScreen("leaderboard");
            }}
            onHomework={() => {
              if (!canOpenHomework) return;
              hapticImpact("light");
              setHomeworkLessonNumber(null);
              setActiveScreen("homeworkUpload");
              setShowAdminPanel(false);
              setBulkEditMode(false);
              setExpandedStudentId(null);
            }}
            onProfile={() => {
              hapticSelection();
              setActiveScreen("profile");
              setShowAdminPanel(false);
              setBulkEditMode(false);
              setExpandedStudentId(null);
            }}
          />
        </>
      )}
    </main>
  );
}

function ProfileScreen({
  schedule,
  scheduleError,
  isAdmin,
  canViewHomework,
  sessionToken,
  previewMode,
  submittedLessonNumbers,
  onSubmitHomework,
  onScheduleChange,
}: {
  schedule: ScheduleResponse;
  scheduleError: string | null;
  isAdmin: boolean;
  canViewHomework: boolean;
  sessionToken: string | null;
  previewMode: boolean;
  submittedLessonNumbers: number[];
  onSubmitHomework: (lessonNumber: number) => void;
  onScheduleChange: (next: ScheduleResponse) => void;
}) {
  const [monthIndex, setMonthIndex] = useState(() => initialScheduleMonthIndex(schedule));
  const [monthMotion, setMonthMotion] = useState<"prev" | "next" | "idle">("idle");
  const [selectedLesson, setSelectedLesson] = useState<LessonScheduleItem | null>(null);
  const [selectedTransfer, setSelectedTransfer] = useState<LessonScheduleTransfer | null>(null);
  const [selectedHomework, setSelectedHomework] = useState<LessonHomework | null>(null);
  const [transferTargetLocal, setTransferTargetLocal] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferSaving, setTransferSaving] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressDayClickRef = useRef(false);
  const previewSnapshotsRef = useRef(new Map<string, LessonScheduleInput[]>());
  const months = schedule.months;
  const safeMonthIndex = Math.min(Math.max(monthIndex, 0), Math.max(0, months.length - 1));
  const currentMonth = months[safeMonthIndex] ?? months[0] ?? null;

  const navigateMonth = (step: -1 | 1) => {
    setMonthIndex((current) => {
      const next = Math.min(Math.max(current + step, 0), Math.max(0, months.length - 1));
      if (next !== current) {
        setSelectedLesson(null);
        setSelectedTransfer(null);
        setSelectedHomework(null);
        setTransferError(null);
        setMonthMotion(step > 0 ? "next" : "prev");
        hapticSelection();
      }
      return next;
    });
  };

  const finishSwipe = (x: number, y: number) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const dx = x - start.x;
    const dy = y - start.y;
    if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.12) return;
    suppressDayClickRef.current = true;
    window.setTimeout(() => {
      suppressDayClickRef.current = false;
    }, 0);
    navigateMonth(dx < 0 ? 1 : -1);
  };

  const selectLesson = (lesson: LessonScheduleItem) => {
    if (suppressDayClickRef.current || transferSaving) return;
    hapticSelection();
    setTransferError(null);
    setSelectedTransfer(null);
    setSelectedLesson(lesson);
    setTransferTargetLocal(defaultTransferTarget(lesson.scheduledAt).slice(0, 16));
    setTransferReason("");
  };

  const selectHomework = (lesson: LessonScheduleItem) => {
    if (suppressDayClickRef.current || !lesson.isCompleted) return;
    const homework = lessonHomeworkByNumber(lesson.lessonNumber);
    if (!homework) return;
    hapticSelection();
    setSelectedLesson(null);
    setSelectedTransfer(null);
    setSelectedHomework(homework);
  };

  const selectTransfer = (transfer: LessonScheduleTransfer) => {
    if (suppressDayClickRef.current || transferSaving) return;
    hapticSelection();
    setTransferError(null);
    setSelectedLesson(null);
    setSelectedTransfer(transfer);
    setTransferReason(transfer.reason ?? "");
  };

  const moveSelectedLesson = async () => {
    if (!selectedLesson || !transferTargetLocal || transferSaving) return;
    const previous = schedule;
    setTransferSaving(true);
    setTransferError(null);
    try {
      const targetScheduledAt = datetimeLocalToBishkekIso(transferTargetLocal);
      const calculated = transferLessonSchedule(
        schedule.lessons,
        selectedLesson.lessonNumber,
        selectedLesson.scheduledAt,
        targetScheduledAt,
      );
      previewSnapshotsRef.current.set(
        calculated.transfer.id,
        schedule.lessons.map((lesson) => ({
          lessonNumber: lesson.lessonNumber,
          scheduledAt: lesson.scheduledAt,
          courseMonth: lesson.courseMonth,
        })),
      );
      const optimistic = buildScheduleResponse(
        calculated.lessons,
        new Date(),
        [...schedule.transfers, { ...calculated.transfer, reason: transferReason.trim() || null }],
        schedule.lessonVideos,
      );
      onScheduleChange(optimistic);
      if (previewMode) {
        hapticNotice("success");
        setSelectedLesson(null);
        return;
      }
      if (!sessionToken) throw new Error("Нет сессии преподавателя");
      const response = await api<ScheduleResponse>("/api/admin/schedule/transfer", {
        method: "POST",
        body: JSON.stringify({
          lessonNumber: selectedLesson.lessonNumber,
          expectedScheduledAt: selectedLesson.scheduledAt,
          targetScheduledAt,
          reason: transferReason,
        }),
      }, sessionToken);
      onScheduleChange(response);
      hapticNotice("success");
      setSelectedLesson(null);
    } catch (caught) {
      onScheduleChange(previous);
      hapticNotice("error");
      setTransferError(caught instanceof Error ? caught.message : "Не удалось перенести занятие");
    } finally {
      setTransferSaving(false);
    }
  };

  const saveSelectedTransferReason = async () => {
    if (!selectedTransfer || transferSaving) return;
    const previous = schedule;
    const reason = transferReason.trim() || null;
    setTransferSaving(true);
    setTransferError(null);
    try {
      const optimistic = buildScheduleResponse(
        schedule.lessons,
        new Date(),
        schedule.transfers.map((transfer) => (
          transfer.id === selectedTransfer.id ? { ...transfer, reason } : transfer
        )),
        schedule.lessonVideos,
      );
      onScheduleChange(optimistic);
      if (!previewMode) {
        if (!sessionToken) throw new Error("Нет сессии преподавателя");
        const response = await api<ScheduleResponse>("/api/admin/schedule/transfer", {
          method: "PATCH",
          body: JSON.stringify({ transferId: selectedTransfer.id, reason }),
        }, sessionToken);
        onScheduleChange(response);
      }
      hapticNotice("success");
      setSelectedTransfer(null);
    } catch (caught) {
      onScheduleChange(previous);
      hapticNotice("error");
      setTransferError(caught instanceof Error ? caught.message : "Не удалось сохранить причину переноса");
    } finally {
      setTransferSaving(false);
    }
  };

  const cancelSelectedTransfer = async () => {
    if (!selectedTransfer || transferSaving) return;
    setTransferSaving(true);
    setTransferError(null);
    try {
      if (previewMode) {
        const snapshot = previewSnapshotsRef.current.get(selectedTransfer.id);
        if (!snapshot) throw new Error("Этот перенос нельзя восстановить в тестовой сессии");
        onScheduleChange(buildScheduleResponse(
          snapshot,
          new Date(),
          schedule.transfers.filter((transfer) => transfer.id !== selectedTransfer.id),
          schedule.lessonVideos,
        ));
        previewSnapshotsRef.current.delete(selectedTransfer.id);
      } else {
        if (!sessionToken) throw new Error("Нет сессии преподавателя");
        const response = await api<ScheduleResponse>("/api/admin/schedule/transfer", {
          method: "DELETE",
          body: JSON.stringify({
            transferId: selectedTransfer.id,
            expectedRescheduledAt: selectedTransfer.rescheduledAt,
          }),
        }, sessionToken);
        onScheduleChange(response);
      }
      hapticNotice("success");
      setSelectedTransfer(null);
    } catch (caught) {
      hapticNotice("error");
      setTransferError(caught instanceof Error ? caught.message : "Не удалось отменить перенос");
    } finally {
      setTransferSaving(false);
    }
  };

  useEffect(() => {
    if (!selectedLesson && !selectedTransfer && !selectedHomework) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !transferSaving) {
        setSelectedLesson(null);
        setSelectedTransfer(null);
        setSelectedHomework(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedHomework, selectedLesson, selectedTransfer, transferSaving]);

  return (
    <section className="profileScreen">
      <div className="calendarHero">
        <div className="calendarTopline">
          <span>Длительность обучения: 1 мес. 12 занятий</span>
        </div>

        {currentMonth && (
          <div
            className={`calendarCard ${(selectedLesson || selectedTransfer) ? "dialogOpen" : ""}`}
            aria-label="Календарь занятий"
            onPointerDown={(event) => {
              swipeStartRef.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => finishSwipe(event.clientX, event.clientY)}
            onPointerCancel={() => {
              swipeStartRef.current = null;
            }}
          >
            <div className="calendarHeader">
              <button
                type="button"
                disabled={safeMonthIndex <= 0}
                onClick={() => navigateMonth(-1)}
                aria-label="Предыдущий учебный месяц"
              >
                ←
              </button>
              <strong>{currentMonth.label}</strong>
              <button
                type="button"
                disabled={safeMonthIndex >= months.length - 1}
                onClick={() => navigateMonth(1)}
                aria-label="Следующий учебный месяц"
              >
                →
              </button>
            </div>
            <div className={`calendarMonthPane ${monthMotion}`} key={currentMonth.key} onAnimationEnd={() => setMonthMotion("idle")}>
              <CalendarMonth
                month={currentMonth}
                lessons={schedule.lessons}
                transfers={schedule.transfers}
                cancellableTransferId={schedule.cancellableTransferId}
                isAdmin={isAdmin}
                canViewHomework={canViewHomework}
                onLessonSelect={selectLesson}
                onHomeworkSelect={selectHomework}
                onTransferSelect={selectTransfer}
              />
            </div>
            {(selectedLesson || selectedTransfer) && (
              <div
                className="calendarTransferOverlay"
                role="presentation"
                onClick={() => {
                  if (!transferSaving) {
                    setSelectedLesson(null);
                    setSelectedTransfer(null);
                  }
                }}
              >
                <div
                  className={`calendarTransferDialog ${selectedTransfer && !isAdmin ? "readOnly" : ""}`}
                  role="dialog"
                  aria-modal="true"
                  aria-label={selectedLesson
                    ? `Перенос занятия ${selectedLesson.lessonNumber}`
                    : `Перенос занятия ${selectedTransfer?.lessonNumber}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="transferPreviewBadge">ПЕРЕНОС</span>
                  <strong>Занятие {selectedLesson?.lessonNumber ?? selectedTransfer?.lessonNumber}</strong>
                  {selectedLesson ? (
                    <>
                      <p>Сейчас: {formatScheduleDate(selectedLesson.scheduledAt)}</p>
                      <button
                        type="button"
                        className="transferSuggestedButton"
                        disabled={transferSaving}
                        onClick={() => setTransferTargetLocal(defaultTransferTarget(selectedLesson.scheduledAt).slice(0, 16))}
                      >
                        <span>Ближайшее по расписанию</span>
                        <strong>{formatScheduleDate(defaultTransferTarget(selectedLesson.scheduledAt))}</strong>
                      </button>
                      <label className="transferTargetField">
                        <span>Или выбери дату и время</span>
                        <input
                          type="datetime-local"
                          value={transferTargetLocal}
                          min={selectedLesson.scheduledAt.slice(0, 16)}
                          disabled={transferSaving}
                          onChange={(event) => setTransferTargetLocal(event.target.value)}
                        />
                      </label>
                      <p className="transferScheduleHint">Дальше занятия продолжатся по ПН / СР / ПТ.</p>
                    </>
                  ) : selectedTransfer ? (
                    <>
                      <p>Перенесено на {formatScheduleDate(selectedTransfer.rescheduledAt)}</p>
                      {!isAdmin && (
                        <div className="transferReasonReadOnly">
                          <strong>ПРИЧИНА</strong>
                          <p>{selectedTransfer.reason || "Причина не указана"}</p>
                        </div>
                      )}
                    </>
                  ) : null}
                  {isAdmin && (
                    <label className="transferReasonField">
                      <span>Причина переноса (необязательно)</span>
                      <textarea
                        value={transferReason}
                        maxLength={300}
                        disabled={transferSaving}
                        placeholder="Например: занятие перенесено по просьбе группы"
                        onChange={(event) => setTransferReason(event.target.value)}
                      />
                    </label>
                  )}
                  {transferError && <p className="transferDialogError">{transferError}</p>}
                  <div className="transferDialogActions">
                    <button
                      type="button"
                      className="transferCancelButton"
                      disabled={transferSaving}
                      onClick={() => {
                        setSelectedLesson(null);
                        setSelectedTransfer(null);
                      }}
                    >
                      Закрыть
                    </button>
                    {isAdmin && (
                      <button
                        type="button"
                        className="transferConfirmButton"
                        disabled={transferSaving}
                        onClick={() => void (selectedLesson ? moveSelectedLesson() : saveSelectedTransferReason())}
                      >
                        {transferSaving
                          ? selectedLesson ? "Переношу..." : "Сохраняю..."
                          : selectedLesson ? "Перенести" : "Сохранить"}
                      </button>
                    )}
                  </div>
                  {isAdmin && selectedTransfer && schedule.cancellableTransferId === selectedTransfer.id && (
                    <button
                      type="button"
                      className="transferUndoButton"
                      disabled={transferSaving}
                      onClick={() => void cancelSelectedTransfer()}
                    >
                      {transferSaving ? "Возвращаю..." : "Отменить перенос"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {scheduleError && <p className="calendarNote error">{scheduleError}</p>}
      </div>
      {selectedHomework && (
        <div
          className="calendarHomeworkOverlay"
          role="presentation"
          onClick={() => setSelectedHomework(null)}
        >
          <article
            className="calendarHomeworkDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-homework-title"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="calendarHomeworkBadge">ЗАНЯТИЕ {selectedHomework.lessonNumber}</span>
            <h2 id="calendar-homework-title">{selectedHomework.title}</h2>
            <div className="calendarHomeworkBody">
              <strong>ДОМАШНЕЕ ЗАДАНИЕ</strong>
              <p>{selectedHomework.body}</p>
            </div>
            <div className="calendarHomeworkActions">
              {!isAdmin && !submittedLessonNumbers.includes(selectedHomework.lessonNumber) && (
                <button
                  type="button"
                  className="calendarHomeworkSubmit"
                  onClick={() => {
                    const lessonNumber = selectedHomework.lessonNumber;
                    setSelectedHomework(null);
                    onSubmitHomework(lessonNumber);
                  }}
                >
                  Сдать ДЗ
                </button>
              )}
              <button type="button" className="calendarHomeworkClose" onClick={() => setSelectedHomework(null)}>Закрыть</button>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

function CalendarMonth({
  month,
  lessons,
  transfers,
  cancellableTransferId,
  isAdmin,
  canViewHomework,
  onLessonSelect,
  onHomeworkSelect,
  onTransferSelect,
}: {
  month: { key: string; year: number; month: number; label: string };
  lessons: ScheduleResponse["lessons"];
  transfers: ScheduleResponse["transfers"];
  cancellableTransferId: string | null;
  isAdmin: boolean;
  canViewHomework: boolean;
  onLessonSelect: (lesson: LessonScheduleItem) => void;
  onHomeworkSelect: (lesson: LessonScheduleItem) => void;
  onTransferSelect: (transfer: LessonScheduleTransfer) => void;
}) {
  const today = bishkekDateKey();
  const transferByDate = new Map(transfers.map((transfer) => [transfer.originalScheduledAt.slice(0, 10), transfer]));
  const latestTransfer = transfers.at(-1) ?? null;
  const byDate = new Map<string, ScheduleResponse["lessons"]>();
  for (const lesson of lessons) {
    const key = lesson.scheduledAt.slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push(lesson);
    byDate.set(key, list);
  }
  const cells = calendarCells(month.year, month.month);
  return (
    <div className="calendarGrid">
      {["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"].map((day) => (
        <span className="calendarWeekday" key={day}>{day}</span>
      ))}
      {cells.map((cell, index) => {
        if (!cell) return <span className="calendarDay empty" key={`empty-${index}`} />;
        const key = `${month.key}-${String(cell).padStart(2, "0")}`;
        const dayLessons = byDate.get(key) ?? [];
        const mainLesson = dayLessons[0] ?? null;
        const completed = dayLessons.some((lesson) => lesson.isCompleted);
        const transfer = transferByDate.get(key) ?? null;
        const isTransfer = Boolean(transfer);
        const isPastOrToday = key <= today;
        const canTransfer = Boolean(isAdmin && mainLesson && key >= today);
        const canOpenLessonHomework = Boolean(
          canViewHomework
          && mainLesson?.isCompleted
          && lessonHomeworkByNumber(mainLesson.lessonNumber),
        );
        const canCancelTransfer = Boolean(
          isAdmin
          && transfer
          && latestTransfer?.id === transfer.id
          && cancellableTransferId === transfer.id,
        );
        const canManageTransfer = Boolean(isAdmin && transfer);
        const canViewTransferReason = Boolean(canViewHomework && transfer);
        const actionable = canManageTransfer || canViewTransferReason || canOpenLessonHomework || canTransfer;
        const className = `calendarDay ${isPastOrToday ? "past" : ""} ${mainLesson ? "lesson" : ""} ${mainLesson && !isPastOrToday ? "upcoming" : ""} ${completed ? "completed" : ""} ${isTransfer ? "transfer" : ""} ${key === today ? "today" : ""} ${actionable ? "actionable" : ""}`;
        const content = (
          <>
            <strong>{cell}</strong>
            {mainLesson && <small className="calendarLessonBadge">{mainLesson.lessonNumber}</small>}
            {isTransfer && <small className="calendarLessonBadge transferBadge">ПЕРЕНОС</small>}
          </>
        );
        if (actionable) {
          return (
            <button
              type="button"
              className={className}
              key={key}
              title={canManageTransfer
                ? canCancelTransfer ? "Отменить перенос или изменить причину" : "Изменить причину переноса"
                : canViewTransferReason ? "Посмотреть причину переноса"
                : canOpenLessonHomework ? `Домашнее задание к занятию ${mainLesson?.lessonNumber}` : `Занятие ${mainLesson?.lessonNumber}`}
              aria-label={canManageTransfer
                ? `Открыть перенос занятия ${transfer?.lessonNumber}`
                : canViewTransferReason
                  ? `Посмотреть причину переноса занятия ${transfer?.lessonNumber}`
                : canOpenLessonHomework
                  ? `Открыть домашнее задание к занятию ${mainLesson?.lessonNumber}`
                  : `Открыть занятие ${mainLesson?.lessonNumber}, ${cell} число`}
              onClick={() => {
                if ((canManageTransfer || canViewTransferReason) && transfer) onTransferSelect(transfer);
                else if (canOpenLessonHomework && mainLesson) onHomeworkSelect(mainLesson);
                else if (mainLesson) onLessonSelect(mainLesson);
              }}
            >
              {content}
            </button>
          );
        }
        return (
          <span
            className={className}
            key={key}
            title={isTransfer ? "Перенос" : mainLesson ? `Занятие ${mainLesson.lessonNumber}` : undefined}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

function datetimeLocalToBishkekIso(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) throw new Error("Дата и время урока обязательны");
  return `${trimmed}:00+06:00`;
}

function initialScheduleMonthIndex(schedule: ScheduleResponse): number {
  const completed = schedule.lessons.filter((lesson) => lesson.isCompleted);
  const source = completed.at(-1) ?? schedule.lessons[0];
  if (!source) return 0;
  const parts = localDateParts(source.scheduledAt);
  const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
  return Math.max(0, schedule.months.findIndex((month) => month.key === key));
}

function formatScheduleDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Bishkek",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function calendarCells(year: number, month: number): Array<number | null> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leading = (firstDay + 6) % 7;
  const cells: Array<number | null> = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length < 42) cells.push(null);
  return cells;
}

function LatestVideoCard({ video }: { video: TeacherLessonVideo | null }) {
  if (!video) return null;
  return (
    <article className="latestVideoCard">
      <div className="latestVideoHead">
        <span>Последнее видео</span>
        <a href={video.videoUrl} target="_blank" rel="noreferrer">
          Открыть
        </a>
      </div>
      <strong>{video.title}</strong>
      <small>{video.courseMonth} мес · урок {video.lessonNumber}</small>
      <div className="latestVideoFrame">
        <iframe
          src={`https://www.youtube.com/embed/${encodeURIComponent(video.videoId)}`}
          title={video.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    </article>
  );
}

function HomeworkUploadScreen({
  isAdmin,
  sessionToken,
  previewRole,
  defaultVideoTitle,
  lessonNumber,
  courseMonth,
  latestVideo,
  onVideoUploaded,
  onHomeworkSubmitted,
}: {
  isAdmin: boolean;
  sessionToken: string | null;
  previewRole: TestRole | null;
  defaultVideoTitle: string;
  lessonNumber: number;
  courseMonth: number;
  latestVideo: TeacherLessonVideo | null;
  onVideoUploaded: () => void;
  onHomeworkSubmitted: (lessonNumber: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const materialInputRef = useRef<HTMLInputElement | null>(null);
  const homeworkInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInFlightRef = useRef(false);
  const autoResumeRef = useRef<() => void>(() => undefined);
  const previousDefaultTitleRef = useRef(defaultVideoTitle);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(() => readTeacherUploadDraft().title ?? defaultVideoTitle);
  const [description, setDescription] = useState(() => readTeacherUploadDraft().description ?? "");
  const [dragActive, setDragActive] = useState(false);
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [materialDragActive, setMaterialDragActive] = useState(false);
  const [materialSavedName, setMaterialSavedName] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [uploadedVideo, setUploadedVideo] = useState<{ id: string; url: string } | null>(null);
  const [localJobId, setLocalJobId] = useState<string | null>(null);
  const [activeUploadJob, setActiveUploadJob] = useState<TeacherUploadJob | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const busy = phase === "creating" || phase === "uploading" || phase === "saving";
  const controlsLocked = busy || phase === "paused" || phase === "finalizing";
  const [homeworkFile, setHomeworkFile] = useState<File | null>(null);
  const [homeworkLinks, setHomeworkLinks] = useState("");
  const [homeworkDescription, setHomeworkDescription] = useState("");
  const [homeworkDragActive, setHomeworkDragActive] = useState(false);
  const [homeworkPhase, setHomeworkPhase] = useState<HomeworkSubmitPhase>("idle");
  const [homeworkMessage, setHomeworkMessage] = useState<string | null>(null);
  const homeworkBusy = homeworkPhase === "submitting";
  const hasHomeworkContent = Boolean(homeworkLinks.trim() || homeworkDescription.trim() || homeworkFile);
  const externalUploadJob = activeUploadJob
    && activeUploadJob.id !== localJobId
    && !busy
    ? activeUploadJob
    : null;
  const materialPending = Boolean(uploadedVideo && materialFile && !materialSavedName);
  const uploadReady = uploadedVideo
    ? materialPending
    : Boolean(file && title.trim() && !externalUploadJob);

  useEffect(() => {
    setTitle((current) => (
      current === previousDefaultTitleRef.current || current === ""
        ? defaultVideoTitle
        : current
    ));
    previousDefaultTitleRef.current = defaultVideoTitle;
  }, [defaultVideoTitle]);

  useEffect(() => {
    if (!isAdmin) return;
    try {
      window.localStorage.setItem(TEACHER_UPLOAD_DRAFT_KEY, JSON.stringify({ title, description }));
    } catch {
      // The mounted component still preserves the draft when storage is unavailable.
    }
  }, [description, isAdmin, title]);

  useEffect(() => {
    if (!isAdmin || !sessionToken || previewRole === "teachers") return;
    let cancelled = false;
    let inFlight = false;
    const refreshUploadJob = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await api<TeacherUploadJobResponse>(
          "/api/admin/youtube/upload-job",
          {},
          sessionToken,
        );
        if (!cancelled) setActiveUploadJob(response.job);
      } catch {
        // Keep the last known progress and retry without disturbing an active upload.
      } finally {
        inFlight = false;
      }
    };
    void refreshUploadJob();
    const timer = window.setInterval(() => void refreshUploadJob(), UPLOAD_JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isAdmin, previewRole, sessionToken]);

  const selectFile = (nextFile: File | null) => {
    if (!nextFile) return;
    const fileType = nextFile.type.toLowerCase();
    const extension = nextFile.name.split(".").pop()?.toLowerCase() ?? "";
    if (nextFile.size <= 0 || (!fileType.startsWith("video/") && !["mp4", "mov", "webm", "m4v", "mkv"].includes(extension))) {
      setUploadError("Выбери видео MP4, MOV, WEBM, M4V или MKV");
      if (inputRef.current) inputRef.current.value = "";
      hapticNotice("warning");
      return;
    }
    setFile(nextFile);
    setResultUrl(null);
    setUploadedVideo(null);
    setMaterialSavedName(null);
    setUploadError(null);
    setProgress(0);
    setPhase("idle");
    if (!title.trim()) setTitle(fileTitle(nextFile));
  };

  const selectMaterialFile = (nextFile: File | null) => {
    if (!nextFile) return;
    try {
      validateTeacherMaterialFile(nextFile);
    } catch (error) {
      setMaterialFile(null);
      setMaterialSavedName(null);
      setUploadError(error instanceof Error ? error.message : "Некорректный файл допматериала");
      if (materialInputRef.current) materialInputRef.current.value = "";
      hapticNotice("warning");
      return;
    }
    setMaterialFile(nextFile);
    setMaterialSavedName(null);
    setUploadError(null);
  };

  const clearMaterialFile = () => {
    setMaterialFile(null);
    setMaterialSavedName(null);
    if (materialInputRef.current) materialInputRef.current.value = "";
  };

  const saveTeacherMaterial = async (
    video: { id: string; url: string },
    material: File,
  ): Promise<string> => {
    if (!sessionToken) throw new Error("Нет сессии преподавателя");
    const session = await api<TeacherMaterialUploadSessionResponse>(
      "/api/admin/materials/upload-session",
      {
        method: "POST",
        body: JSON.stringify({
          lessonNumber,
          courseMonth,
          videoId: video.id,
          videoUrl: video.url,
          fileName: material.name,
          fileType: material.type || "application/octet-stream",
          fileSize: material.size,
        }),
      },
      sessionToken,
    );
    if (session.completed) return session.fileName;

    const confirmedParts = new Map(
      session.uploadedParts.map((part) => [part.partNumber, part.size]),
    );
    const partCount = Math.ceil(material.size / session.partSize);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * session.partSize;
      const end = Math.min(material.size, start + session.partSize);
      const part = material.slice(start, end);
      if (confirmedParts.get(partNumber) === part.size) continue;

      let lastError: unknown = null;
      for (let attempt = 0; attempt < MATERIAL_UPLOAD_RETRIES; attempt += 1) {
        try {
          await apiBinary<TeacherMaterialUploadPartResponse>(
            `/api/admin/materials/upload-part?sessionId=${encodeURIComponent(session.sessionId)}&partNumber=${partNumber}`,
            part,
            sessionToken,
          );
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < MATERIAL_UPLOAD_RETRIES) {
            await sleep(500 * (2 ** attempt));
          }
        }
      }
      if (lastError) throw lastError;
    }

    const saved = await api<TeacherMaterialUploadResponse>(
      "/api/admin/materials/complete",
      {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId }),
      },
      sessionToken,
    );
    return saved.fileName;
  };

  const reportUploadJob = async (
    jobId: string,
    patch: {
      progress?: number;
      phase?: "creating" | "uploading" | "finalizing" | "paused" | "saving" | "done" | "error";
      videoId?: string | null;
      videoUrl?: string | null;
      errorMessage?: string | null;
      confirmedOffset?: number;
      chunkSize?: number | null;
      diagnostic?: UploadChunkDiagnosticInput;
    },
  ): Promise<TeacherUploadJob | null> => {
    if (!sessionToken) return null;
    const response = await api<TeacherUploadJobResponse>("/api/admin/youtube/upload-job", {
      method: "PATCH",
      body: JSON.stringify({ jobId, ...patch }),
    }, sessionToken);
    setActiveUploadJob(response.job);
    return response.job;
  };

  useEffect(() => {
    if (!busy || !localJobId || !sessionToken) return;
    const heartbeat = window.setInterval(() => {
      void api<TeacherUploadJobResponse>("/api/admin/youtube/upload-job", {
        method: "PATCH",
        body: JSON.stringify({
          jobId: localJobId,
          phase,
          progress,
          errorMessage: null,
        }),
      }, sessionToken)
        .then((response) => setActiveUploadJob(response.job))
        .catch(() => undefined);
    }, 7_000);
    return () => window.clearInterval(heartbeat);
  }, [busy, localJobId, phase, progress, sessionToken]);

  const submitUpload = async () => {
    if (!isAdmin || busy || uploadInFlightRef.current || !uploadReady) return;
    uploadInFlightRef.current = true;
    let attemptJobId = localJobId;
    setUploadError(null);
    try {
      if (uploadedVideo) {
        if (!materialFile || materialSavedName) return;
        setPhase("saving");
        if (attemptJobId) {
          await reportUploadJob(attemptJobId, { phase: "saving", progress: 100, errorMessage: null })
            .catch(() => undefined);
        }
        if (!sessionToken && previewRole === "teachers") {
          await sleep(180);
          setMaterialSavedName(materialFile.name);
          setPhase("done");
          hapticNotice("success");
          return;
        }
        try {
          setMaterialSavedName(await saveTeacherMaterial(uploadedVideo, materialFile));
          setPhase("done");
          if (attemptJobId) {
            await reportUploadJob(attemptJobId, {
              phase: "done",
              progress: 100,
              videoId: uploadedVideo.id,
              videoUrl: uploadedVideo.url,
              errorMessage: null,
            }).catch(() => undefined);
          }
          hapticNotice("success");
        } catch (caught) {
          const message = `Допматериал не сохранён: ${caught instanceof Error ? caught.message : "ошибка загрузки"}`;
          setUploadError(message);
          setPhase("error");
          if (attemptJobId) {
            await reportUploadJob(attemptJobId, {
              phase: "error",
              progress: 100,
              videoId: uploadedVideo.id,
              videoUrl: uploadedVideo.url,
              errorMessage: message,
            }).catch(() => undefined);
          }
          hapticNotice("warning");
        }
        return;
      }

      if (!file || !title.trim()) return;
      setResultUrl(null);
      const continuingSavedUpload = Boolean(localJobId)
        && (phase === "paused" || phase === "finalizing" || phase === "error");
      if (!continuingSavedUpload) {
        setProgress(0);
        setPhase("creating");
      }
      if (!sessionToken && previewRole === "teachers") {
        await sleep(280);
        setProgress(100);
        setMaterialSavedName(materialFile?.name ?? null);
        setResultUrl("#test-video");
        setUploadedVideo({ id: "test-video", url: "#test-video" });
        setPhase("done");
        hapticNotice("success");
        return;
      }
      if (!sessionToken) throw new Error("Нет сессии преподавателя");
      let uploadUrl: string;
      let accessToken: string;
      let startOffset = 0;
      let stableChunkSize = preferredYouTubeUploadChunkSize(file.size);
      let completedVideoId: string | null = null;

      if (continuingSavedUpload && localJobId) {
        const resumed = await api<YouTubeUploadResumeResponse>("/api/admin/youtube/resume", {
          method: "POST",
          body: JSON.stringify({
            jobId: localJobId,
            fileName: file.name,
            fileSize: file.size,
          }),
        }, sessionToken);
        attemptJobId = resumed.job.id;
        setActiveUploadJob(resumed.job);
        startOffset = resumed.nextOffset;
        stableChunkSize = resumed.job.chunkSize ?? stableChunkSize;
        setProgress(Math.min(100, Math.round((startOffset / file.size) * 100)));
        if (resumed.completed && resumed.video) {
          completedVideoId = resumed.video.videoId;
          uploadUrl = "";
          accessToken = "";
        } else if (resumed.state === "processing") {
          throw createFinalizingUploadError(file.size, stableChunkSize);
        } else {
          if (!resumed.uploadUrl || !resumed.accessToken) {
            throw new Error("YouTube не вернул данные для продолжения загрузки");
          }
          uploadUrl = resumed.uploadUrl;
          accessToken = resumed.accessToken;
        }
      } else {
        const session = await api<YouTubeUploadSessionResponse>("/api/admin/youtube/upload-session", {
          method: "POST",
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim(),
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || "application/octet-stream",
            privacyStatus: "unlisted",
            lessonNumber,
            courseMonth,
            chunkSize: stableChunkSize,
          }),
        }, sessionToken);
        attemptJobId = session.jobId;
        setLocalJobId(session.jobId);
        if (session.reused) {
          const resumed = await api<YouTubeUploadResumeResponse>("/api/admin/youtube/resume", {
            method: "POST",
            body: JSON.stringify({
              jobId: session.jobId,
              fileName: file.name,
              fileSize: file.size,
            }),
          }, sessionToken);
          setActiveUploadJob(resumed.job);
          startOffset = resumed.nextOffset;
          stableChunkSize = resumed.job.chunkSize ?? stableChunkSize;
          setProgress(Math.min(100, Math.round((startOffset / file.size) * 100)));
          if (resumed.completed && resumed.video) {
            completedVideoId = resumed.video.videoId;
            uploadUrl = "";
            accessToken = "";
          } else if (resumed.state === "processing") {
            throw createFinalizingUploadError(file.size, stableChunkSize);
          } else {
            if (!resumed.uploadUrl || !resumed.accessToken) {
              throw new Error("YouTube не вернул данные сохранённой загрузки");
            }
            uploadUrl = resumed.uploadUrl;
            accessToken = resumed.accessToken;
          }
        } else {
          if (!session.uploadUrl || !session.accessToken) {
            throw new Error("YouTube не вернул данные новой загрузки");
          }
          uploadUrl = session.uploadUrl;
          accessToken = session.accessToken;
        }
      }

      const uploadJobId = attemptJobId;
      if (!uploadJobId) throw new Error("Не удалось сохранить состояние загрузки");
      setPhase("uploading");
      const videoId = completedVideoId ?? await uploadFileToYouTube({
        file,
        uploadUrl,
        accessToken,
        startOffset,
        chunkSize: stableChunkSize,
        refreshAccessToken: async () => {
          const refreshed = await api<YouTubeAccessTokenResponse>("/api/admin/youtube/access-token", {
            method: "POST",
          }, sessionToken);
          return refreshed.accessToken;
        },
        reconcileUpload: async () => {
          const reconciled = await api<YouTubeUploadReconcileResponse>("/api/admin/youtube/reconcile", {
            method: "POST",
            body: JSON.stringify({ jobId: uploadJobId }),
          }, sessionToken);
          return {
            videoId: reconciled.video?.videoId ?? null,
            nextOffset: reconciled.nextOffset,
            state: reconciled.state,
          };
        },
        onProgress: (nextProgress) => {
          setProgress(nextProgress);
        },
        onDiagnostic: async (diagnostic) => {
          const nextProgress = Math.min(
            diagnostic.outcome === "completed" ? 100 : 99,
            Math.round((diagnostic.confirmedOffset / file.size) * 100),
          );
          await reportUploadJob(uploadJobId, {
            phase: "uploading",
            progress: nextProgress,
            confirmedOffset: diagnostic.confirmedOffset,
            chunkSize: diagnostic.chunkSize,
            diagnostic,
            errorMessage: null,
          });
        },
      });
      const videoUrl = `https://youtu.be/${videoId}`;
      const completedVideo = { id: videoId, url: videoUrl };
      setResultUrl(videoUrl);
      setUploadedVideo(completedVideo);
      if (materialFile) {
        setPhase("saving");
        await reportUploadJob(uploadJobId, {
          phase: "saving",
          progress: 100,
          videoId,
          videoUrl,
          errorMessage: null,
        }).catch(() => undefined);
        onVideoUploaded();
        try {
          setMaterialSavedName(await saveTeacherMaterial(completedVideo, materialFile));
        } catch (caught) {
          const message = `Видео загружено, но допматериал не сохранён: ${caught instanceof Error ? caught.message : "ошибка загрузки"}`;
          setUploadError(message);
          setPhase("error");
          await reportUploadJob(uploadJobId, {
            phase: "error",
            progress: 100,
            videoId,
            videoUrl,
            errorMessage: message,
          }).catch(() => undefined);
          onVideoUploaded();
          hapticNotice("warning");
          return;
        }
      }
      setPhase("done");
      await reportUploadJob(uploadJobId, {
        phase: "done",
        progress: 100,
        videoId,
        videoUrl,
        errorMessage: null,
      }).catch(() => undefined);
      onVideoUploaded();
      hapticNotice("success");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Не удалось загрузить видео";
      setUploadError(message);
      if (isFinalizingUploadError(caught)) {
        setPhase("finalizing");
        setProgress(100);
        if (attemptJobId) {
          await reportUploadJob(attemptJobId, {
            phase: "finalizing",
            progress: 100,
            confirmedOffset: caught.nextOffset,
            chunkSize: caught.chunkSize,
            errorMessage: null,
          }).catch(() => undefined);
        }
      } else if (isPausedUploadError(caught)) {
        setPhase("paused");
        if (file) {
          setProgress(Math.min(99, Math.round((caught.nextOffset / file.size) * 100)));
        }
        if (attemptJobId) {
          await reportUploadJob(attemptJobId, {
            phase: "paused",
            progress: file
              ? Math.min(99, Math.round((caught.nextOffset / file.size) * 100))
              : undefined,
            confirmedOffset: caught.nextOffset,
            chunkSize: caught.chunkSize,
            errorMessage: message,
          }).catch(() => undefined);
        }
        hapticNotice("warning");
      } else {
        setPhase("error");
        if (attemptJobId) {
          await reportUploadJob(attemptJobId, {
            phase: "error",
            errorMessage: message,
          }).catch(() => undefined);
        }
        hapticNotice("error");
      }
    } finally {
      uploadInFlightRef.current = false;
    }
  };

  useEffect(() => {
    autoResumeRef.current = () => {
      void submitUpload();
    };
  });

  useEffect(() => {
    if (!isAdmin || !sessionToken || previewRole === "teachers") return;
    const finalizingJobId = activeUploadJob?.phase === "finalizing"
      ? activeUploadJob.id
      : phase === "finalizing"
        ? localJobId
        : null;
    if (!finalizingJobId) return;

    let cancelled = false;
    let inFlight = false;
    const reconcileFinalizingUpload = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const reconciled = await api<YouTubeUploadReconcileResponse>("/api/admin/youtube/reconcile", {
          method: "POST",
          body: JSON.stringify({ jobId: finalizingJobId }),
        }, sessionToken);
        if (cancelled) return;
        setActiveUploadJob(reconciled.job);
        if (reconciled.video && finalizingJobId === localJobId) {
          const video = {
            id: reconciled.video.videoId,
            url: reconciled.video.videoUrl,
          };
          setResultUrl(video.url);
          setUploadedVideo(video);
          setProgress(100);
          setPhase("done");
          setUploadError(null);
          onVideoUploaded();
          hapticNotice("success");
        }
      } catch {
        // Finalization is intentionally patient: never restart or resend the video here.
      } finally {
        inFlight = false;
      }
    };

    void reconcileFinalizingUpload();
    const timer = window.setInterval(() => void reconcileFinalizingUpload(), 6_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeUploadJob?.id,
    activeUploadJob?.phase,
    isAdmin,
    localJobId,
    onVideoUploaded,
    phase,
    previewRole,
    sessionToken,
  ]);

  useEffect(() => {
    if (phase !== "paused" || !file || !localJobId) return;
    const continueAfterReconnect = () => autoResumeRef.current();
    window.addEventListener("online", continueAfterReconnect);
    return () => window.removeEventListener("online", continueAfterReconnect);
  }, [file, localJobId, phase]);

  const selectHomeworkFile = (nextFile: File | null) => {
    if (!nextFile) return;
    setHomeworkFile(nextFile);
    setHomeworkMessage(null);
    setHomeworkPhase("idle");
  };

  const submitHomework = async () => {
    if (homeworkBusy || !hasHomeworkContent) return;
    if (!homeworkLinksAreValid(homeworkLinks)) {
      setHomeworkPhase("error");
      setHomeworkMessage("В ссылках оставь URL, сайт или @username. Лучше по одной строке.");
      hapticNotice("warning");
      return;
    }
    setHomeworkPhase("submitting");
    setHomeworkMessage(null);
    try {
      if (!sessionToken && previewRole === "students") {
        await sleep(220);
        setHomeworkLinks("");
        setHomeworkDescription("");
        setHomeworkFile(null);
        setHomeworkPhase("done");
        setHomeworkMessage("ДЗ принято в тестовом режиме");
        onHomeworkSubmitted(lessonNumber);
        hapticNotice("success");
        return;
      }
      if (!sessionToken) throw new Error("Нет сессии ученика");
      const form = new FormData();
      form.set("links", homeworkLinks.trim());
      form.set("description", homeworkDescription.trim());
      form.set("extra", "");
      form.set("lessonNumber", String(lessonNumber));
      if (homeworkFile) form.set("file", homeworkFile);
      const result = await apiForm<HomeworkSubmitResponse>("/api/homework/submit", form, sessionToken);
      setHomeworkLinks("");
      setHomeworkDescription("");
      setHomeworkFile(null);
      setHomeworkPhase("done");
      setHomeworkMessage(result.fileName ? `ДЗ отправлено: ${result.fileName}` : "ДЗ отправлено");
      onHomeworkSubmitted(result.lessonNumber);
      hapticNotice("success");
    } catch (caught) {
      setHomeworkPhase("error");
      setHomeworkMessage(caught instanceof Error ? caught.message : "Не удалось отправить ДЗ");
      hapticNotice("error");
    }
  };

  const clearExternalUploadJob = async () => {
    if (
      !sessionToken
      || !externalUploadJob
      || (!externalUploadJob.isStale && externalUploadJob.phase !== "paused")
    ) return;
    try {
      await api<{ ok: boolean }>("/api/admin/youtube/upload-job", {
        method: "DELETE",
        body: JSON.stringify({ jobId: externalUploadJob.id }),
      }, sessionToken);
      setActiveUploadJob(null);
      hapticNotice("success");
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "Не удалось освободить загрузку");
      hapticNotice("error");
    }
  };

  if (!sessionToken && !previewRole) return null;

  if (!isAdmin) {
    return (
      <section className="uploadScreen">
        <form className="homeworkCard" onSubmit={(event) => {
          event.preventDefault();
          void submitHomework();
        }}>
          <LatestVideoCard video={latestVideo} />

          <label className="uploadField">
            <textarea
              className="compactTextarea homeworkLinksInput"
              value={homeworkLinks}
              disabled={homeworkBusy}
              maxLength={5000}
              aria-label="Ссылки на домашнее задание"
              placeholder={"Ссылки,\ngithub,\n@Sites,\n@telegram_bot"}
              onChange={(event) => setHomeworkLinks(event.target.value)}
            />
          </label>

          <label className="uploadField">
            <textarea
              value={homeworkDescription}
              disabled={homeworkBusy}
              maxLength={5000}
              aria-label="Описание домашнего задания"
              placeholder="Можешь дополнить от себя.."
              onChange={(event) => setHomeworkDescription(event.target.value)}
            />
          </label>

          <label
            className={`dropZone homeworkDrop ${homeworkDragActive ? "active" : ""} ${homeworkFile ? "hasFile" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setHomeworkDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setHomeworkDragActive(true);
            }}
            onDragLeave={() => setHomeworkDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setHomeworkDragActive(false);
              selectHomeworkFile(event.dataTransfer.files.item(0));
            }}
          >
            <input
              ref={homeworkInputRef}
              type="file"
              accept=".md,.markdown,.zip,.pdf,.html,.htm,.ppt,.pptx,.txt,.doc,.docx,image/*,video/*"
              disabled={homeworkBusy}
              onChange={(event) => selectHomeworkFile(event.target.files?.item(0) ?? null)}
            />
            <span className="dropIcon">↑</span>
            <strong>{homeworkFile ? homeworkFile.name : "нажми или перетащи"}</strong>
            <small>{homeworkFile ? formatBytes(homeworkFile.size) : ".md .zip .pdf .html .pptx"}</small>
          </label>

          {homeworkMessage && <p className={`uploadMessage ${homeworkPhase === "error" ? "error" : "success"}`}>{homeworkMessage}</p>}

          <div className="uploadActions homeworkSubmitActions">
            <button type="submit" className="uploadPrimary" disabled={homeworkBusy || !hasHomeworkContent}>
              {homeworkBusy ? "Отправляю..." : "Отправить"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (externalUploadJob) {
    return (
      <section className="uploadScreen">
        <div className="uploadMonitorCard" role="status" aria-live="polite">
          <span className="uploadMonitorEyebrow">{uploadJobStatusLabel(externalUploadJob)}</span>
          <strong>{externalUploadJob.title}</strong>
          <small>{externalUploadJob.fileName} · {formatBytes(externalUploadJob.fileSize)}</small>
          <div className="uploadProgress" aria-label={`Загрузка ${externalUploadJob.progress}%`}>
            <span style={{ width: `${externalUploadJob.progress}%` }} />
            <strong>{externalUploadJob.progress}%</strong>
          </div>
          {externalUploadJob.phase === "paused" ? (
            <>
              <p>
                Передача приостановлена на {externalUploadJob.progress}%.
                Продолжи на устройстве, где выбран исходный видеофайл.
              </p>
              <button type="button" className="uploadMonitorReset" onClick={() => void clearExternalUploadJob()}>
                Отменить загрузку
              </button>
            </>
          ) : externalUploadJob.isStale ? (
            <>
              <p>Устройство перестало передавать прогресс. Вернись к нему, чтобы продолжить загрузку.</p>
              <button type="button" className="uploadMonitorReset" onClick={() => void clearExternalUploadJob()}>
                Освободить загрузку
              </button>
            </>
          ) : (
            <p>Можно наблюдать отсюда. Новое видео будет доступно после завершения текущего.</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="uploadScreen">
      <form className="teacherVideoForm" onSubmit={(event) => {
        event.preventDefault();
        void submitUpload();
      }}>
        <label className="uploadField">
          <input
            value={title}
            disabled={controlsLocked}
            maxLength={100}
            aria-label="Название ролика"
            placeholder={defaultVideoTitle}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="uploadField">
          <textarea
            className="teacherVideoDescription"
            value={description}
            disabled={controlsLocked}
            maxLength={5000}
            aria-label="Описание и домашнее задание"
            placeholder={"Название темы\nДомашнее задание\nTelegram-бот"}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <LatestVideoCard video={latestVideo} />

        <label
          className={`dropZone teacherVideoDrop ${dragActive ? "active" : ""} ${file ? "hasFile" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            selectFile(event.dataTransfer.files.item(0));
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            disabled={controlsLocked}
            onChange={(event) => selectFile(event.target.files?.item(0) ?? null)}
          />
          <span className="dropIcon">↑</span>
          <strong>{file ? file.name : "Перетащи видео сюда"}</strong>
          <small>{file ? `${file.type || "video"} · ${formatBytes(file.size)}` : "или нажми, чтобы выбрать MP4 / MOV / WEBM"}</small>
        </label>

        <div
          className={`dropZone teacherMaterialDrop ${materialDragActive ? "active" : ""} ${materialFile ? "hasFile" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setMaterialDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setMaterialDragActive(true);
          }}
          onDragLeave={() => setMaterialDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setMaterialDragActive(false);
            selectMaterialFile(event.dataTransfer.files.item(0));
          }}
        >
          <input
            ref={materialInputRef}
            type="file"
            accept=".ppt,.pptx,.pdf,.doc,.docx,.xls,.xlsx,.zip,.md,.markdown,.html,.htm,.txt,.csv,.json,.png,.jpg,.jpeg,.webp"
            disabled={controlsLocked}
            aria-label="Необязательный допматериал"
            onChange={(event) => selectMaterialFile(event.target.files?.item(0) ?? null)}
          />
          <span className="dropIcon">+</span>
          <strong>{materialFile ? materialFile.name : "Допматериалы"}</strong>
          <small>{materialFile ? formatBytes(materialFile.size) : "необязательно · PPTX / PDF / ZIP"}</small>
          {materialFile && (
            <button
              type="button"
              className="materialClear"
              disabled={controlsLocked}
              aria-label="Убрать допматериал"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearMaterialFile();
              }}
            >
              ×
            </button>
          )}
        </div>

        {(busy || phase === "paused" || phase === "finalizing") && (
          <div className="uploadProgress" aria-label={`Загрузка ${progress}%`}>
            <span style={{ width: `${phase === "creating" ? 8 : phase === "saving" || phase === "finalizing" ? 100 : progress}%` }} />
            <strong>
              {phase === "creating"
                ? "Готовлю YouTube..."
                : phase === "saving"
                  ? "Сохраняю допматериал..."
                  : phase === "finalizing"
                    ? "YouTube обрабатывает..."
                  : phase === "paused"
                    ? `Приостановлено · ${progress}%`
                  : `${progress}%`}
            </strong>
          </div>
        )}

        {uploadError && <p className="uploadMessage error">{uploadError}</p>}
        {resultUrl && (
          <p className="uploadMessage success">
            {resultUrl === "#test-video" ? (
              "Видео подготовлено в тестовом режиме"
            ) : (
              <>Видео готово: <a href={resultUrl} target="_blank" rel="noreferrer">{resultUrl}</a></>
            )}
            {materialSavedName && <><br />Допматериал сохранён: {materialSavedName}</>}
          </p>
        )}

        <div className="uploadActions teacherUploadActions">
          <button type="submit" className="uploadPrimary" disabled={busy || !uploadReady}>
            {phase === "uploading"
              ? "Загружаю..."
              : phase === "finalizing"
                ? "Проверить статус"
              : phase === "paused"
                ? "Продолжить"
              : phase === "saving"
                ? "Сохраняю..."
                : materialPending
                  ? uploadError
                    ? "Повторить допматериал"
                    : "Сохранить допматериал"
                  : uploadedVideo
                    ? "Готово"
                    : "Загрузить"}
          </button>
        </div>
      </form>
    </section>
  );
}

function AdminPanel({
  sessionToken,
  previewMode,
  previewStudents,
  onChange,
}: {
  sessionToken: string | null;
  previewMode: boolean;
  previewStudents: StudentView[];
  onChange: (next: AdminStudentsResponse) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);

  const createStudent = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      if (previewMode) {
        const telegramValue = telegram.trim();
        const telegramUserId = isTelegramId(telegramValue) ? telegramValue : null;
        const telegramUsername = telegramUserId ? null : normalizeUsernameInput(telegramValue);
        const student: StudentView = {
          id: `preview-${Date.now()}`,
          telegramUserId,
          telegramUsername,
          displayName: displayName.trim(),
          avatarUrl: publicTelegramAvatarUrl(telegramUsername),
          status: "active",
          scores: Array.from({ length: 12 }, (_, index) => ({ lessonNumber: index + 1, score: null, updatedAt: null })),
          completedLessons: 0,
          totalScore: 0,
          lastScoredAt: null,
          place: null,
          pointsBehindLeader: 0,
          isCurrentUser: false,
        };
        onChange({ students: rankVisibleStudents([...previewStudents, student]), pendingStudents: [] });
        setDisplayName("");
        setTelegram("");
        hapticNotice("success");
        return;
      }
      if (!sessionToken) throw new Error("Нет сессии преподавателя");
      const response = await api<AdminStudentsResponse>("/api/admin/students", {
        method: "POST",
        body: JSON.stringify({ displayName, telegram }),
      }, sessionToken);
      setDisplayName("");
      setTelegram("");
      onChange(response);
      hapticNotice("success");
    } catch {
      hapticNotice("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin">
      <form className="addRow" onSubmit={(event) => {
        event.preventDefault();
        void createStudent();
      }}>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Имя ученика" />
        <input value={telegram} onChange={(event) => setTelegram(event.target.value)} placeholder="@username или Telegram ID" />
        <button type="submit" disabled={busy || !displayName.trim()} aria-busy={busy}>Добавить</button>
      </form>
    </section>
  );
}

function Leaderboard({
  students,
  isAdmin,
  expandedStudentId,
  bulkEditMode,
  onBulkEditClose,
  onToggleStudent,
  onScoreChange,
  onBulkStudentChange,
}: {
  students: StudentView[];
  isAdmin: boolean;
  expandedStudentId: string | null;
  bulkEditMode: boolean;
  onBulkEditClose: () => void;
  onToggleStudent: (studentId: string) => void;
  onScoreChange: (student: StudentView, lessonNumber: number, score: number | null) => Promise<void>;
  onBulkStudentChange: (changes: StudentChange[]) => Promise<void>;
}) {
  const [activeLesson, setActiveLesson] = useState<{ studentId: string; lessonNumber: number } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, StudentDraft>>({});
  const [bulkSaving, setBulkSaving] = useState(false);

  const toggleStudentFromRow = (student: StudentView) => {
    setActiveLesson(null);
    onToggleStudent(student.id);
  };

  const handleStudentKeyDown = (event: ReactKeyboardEvent<HTMLElement>, student: StudentView) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,select")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleStudentFromRow(student);
  };

  const saveScore = async (student: StudentView, lessonNumber: number, score: number | null) => {
    const key = `${student.id}:${lessonNumber}`;
    setActiveLesson(null);
    hapticImpact("light");
    try {
      window.setTimeout(() => {
        setSavingKey((current) => current === key ? null : current);
      }, 220);
      setSavingKey(key);
      await onScoreChange(student, lessonNumber, score);
      hapticNotice("success");
    } catch {
      hapticNotice("error");
      setActiveLesson({ studentId: student.id, lessonNumber });
    } finally {
      setSavingKey(null);
    }
  };

  const updateBulkDraft = (student: StudentView, field: EditField, value: string) => {
    setBulkDrafts((current) => ({
      ...current,
      [student.id]: {
        ...(current[student.id] ?? {
          displayName: student.displayName,
          telegram: telegramDraftValue(student),
        }),
        [field]: value,
      },
    }));
  };

  const bulkChanges = () => {
    const changes: StudentChange[] = [];
    for (const student of students) {
      const draft = bulkDrafts[student.id] ?? { displayName: student.displayName, telegram: telegramDraftValue(student) };
      const patch = buildStudentPatch(student, draft);
      if (patch) changes.push({ student, patch });
    }
    return changes;
  };

  const saveBulkChanges = async () => {
    let changes: StudentChange[] = [];
    try {
      changes = bulkChanges();
    } catch {
      hapticNotice("error");
      return;
    }
    if (changes.length === 0) {
      onBulkEditClose();
      return;
    }
    setBulkSaving(true);
    try {
      await onBulkStudentChange(changes);
      hapticNotice("success");
      onBulkEditClose();
    } catch {
      hapticNotice("error");
    } finally {
      setBulkSaving(false);
    }
  };

  let bulkChangeCount = 0;
  if (bulkEditMode) {
    try {
      bulkChangeCount = bulkChanges().length;
    } catch {
      bulkChangeCount = 1;
    }
  }

  if (students.length === 0) return <Panel text="Пока нет активных учеников" />;
  return (
    <section className="leaderboard">
      {bulkEditMode && (
        <div className="bulkActions">
          <button type="button" className="bulkCancel" disabled={bulkSaving} onClick={onBulkEditClose}>Отмена</button>
          <button type="button" className="bulkSave" disabled={bulkSaving} onClick={() => void saveBulkChanges()}>
            {bulkSaving ? "Сохраняю..." : bulkChangeCount > 0 ? `Сохранить ${bulkChangeCount}` : "Готово"}
          </button>
        </div>
      )}
      {students.map((student, index) => {
        const bulkDraft = bulkDrafts[student.id] ?? { displayName: student.displayName, telegram: telegramDraftValue(student) };
        const isExpanded = expandedStudentId === student.id;
        const activeForStudent = activeLesson?.studentId === student.id ? activeLesson.lessonNumber : null;
        const isSavingStudent = savingKey?.startsWith(`${student.id}:`) ?? false;
        if (bulkEditMode) {
          return (
            <article
              className={`student bulkEditing ${student.isCurrentUser ? "current" : ""} ${bulkSaving ? "saving" : ""}`}
              key={student.id}
              style={{
                "--rank": index,
                viewTransitionName: `student-${student.id.replace(/[^a-z0-9_-]/gi, "-")}`,
              } as CSSProperties}
            >
              <div className="bulkStudentRow">
                <Avatar student={student} />
                <div className="bulkFields">
                  <input
                    className="bulkInput bulkName"
                    value={bulkDraft.displayName}
                    disabled={bulkSaving}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onFocus={(event) => focusEditableFieldEnd(event.currentTarget)}
                    placeholder="Имя"
                    onChange={(event) => updateBulkDraft(student, "displayName", event.target.value)}
                  />
                  <input
                    className="bulkInput bulkTelegram"
                    value={bulkDraft.telegram}
                    disabled={bulkSaving}
                    placeholder="@username или TG ID"
                    inputMode={isTelegramId(bulkDraft.telegram) ? "numeric" : "text"}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onFocus={(event) => focusEditableFieldEnd(event.currentTarget)}
                    onChange={(event) => updateBulkDraft(student, "telegram", event.target.value)}
                  />
                </div>
              </div>
            </article>
          );
        }
        return (
          <article
            className={`student ${student.isCurrentUser ? "current" : ""} ${isExpanded ? "expanded" : ""} ${isSavingStudent ? "saving" : ""}`}
            key={student.id}
            style={{
              "--rank": index,
              viewTransitionName: `student-${student.id.replace(/[^a-z0-9_-]/gi, "-")}`,
            } as CSSProperties}
          >
            <div
              className="studentMain"
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("button,input,select")) return;
                toggleStudentFromRow(student);
              }}
              onKeyDown={(event) => handleStudentKeyDown(event, student)}
            >
              <span className="place">{student.place}</span>
              <Avatar student={student} showMedal />
              <div className="studentInfo">
                <strong>{student.displayName}</strong>
                <span>{homeworkLabel(student.completedLessons)}</span>
              </div>
              <button
                type="button"
                className="delta"
                aria-expanded={isExpanded}
                onClick={() => {
                  setActiveLesson(null);
                  onToggleStudent(student.id);
                }}
              >
                {student.totalScore}
              </button>
            </div>
            <div className="lessonTabs" aria-label={`Баллы за 12 домашек: ${student.displayName}`}>
              {student.scores.map((cell) => (
                <span
                  className={`lessonTab ${cell.score === null ? "" : "filled"}`}
                  key={cell.lessonNumber}
                  title={`ДЗ ${cell.lessonNumber}: ${cell.score ?? "—"}`}
                >
                  <strong>{cell.score ?? cell.lessonNumber}</strong>
                </span>
              ))}
            </div>
            {expandedStudentId === student.id && (
              <div className="lessonEditor">
                <div className="lessonGrid">
                  {student.scores.map((cell) => {
                    return (
                      <button
                        type="button"
                        className={`lessonChip ${cell.score === null ? "" : "filled"} ${activeForStudent === cell.lessonNumber ? "active" : ""}`}
                        key={cell.lessonNumber}
                        disabled={!isAdmin}
                        onClick={() => {
                          hapticSelection();
                          setActiveLesson((current) =>
                            current?.studentId === student.id && current.lessonNumber === cell.lessonNumber
                              ? null
                              : { studentId: student.id, lessonNumber: cell.lessonNumber },
                          );
                        }}
                      >
                        <strong>{cell.score ?? cell.lessonNumber}</strong>
                      </button>
                    );
                  })}
                </div>
                {isAdmin && activeForStudent && (
                  <div className="scorePicker">
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
                      <button
                        type="button"
                        className="scoreOption"
                        key={score}
                        disabled={savingKey === `${student.id}:${activeForStudent}`}
                        onClick={() => void saveScore(student, activeForStudent, score)}
                      >
                        {score}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="scoreClear"
                      disabled={savingKey === `${student.id}:${activeForStudent}`}
                      onClick={() => void saveScore(student, activeForStudent, null)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function Avatar({ student, showMedal = false }: { student: StudentView; showMedal?: boolean }) {
  const [failed, setFailed] = useState(false);
  const initial = student.displayName
    .split(/\s+/)
    .filter(Boolean)
    .at(0)
    ?.at(0)
    ?.toUpperCase();
  const medal = showMedal && student.place ? podiumMedal(student.place) : null;
  const avatar = shouldUseAvatar(student) && !failed
    ? <img className="avatar" src={student.avatarUrl} alt="" onError={() => setFailed(true)} />
    : <span className="avatar fallback">{initial || "G"}</span>;

  return (
    <span className={`avatarWrap ${medal ? "withMedal" : ""}`}>
      {avatar}
      {medal && (
        <span className={`podiumMedal ${medal.kind}`} aria-label={medal.label} title={medal.label}>
          <span className="medalBand left" aria-hidden="true" />
          <span className="medalBand right" aria-hidden="true" />
          <span className="medalBadge">{medal.place}</span>
        </span>
      )}
    </span>
  );
}

function podiumMedal(place: number) {
  if (place === 1) return { place, kind: "gold", label: "1 место" };
  if (place === 2) return { place, kind: "silver", label: "2 место" };
  if (place === 3) return { place, kind: "bronze", label: "3 место" };
  return null;
}

function BottomNav({
  activeScreen,
  canOpenHomework,
  onLeaderboard,
  onHomework,
  onProfile,
}: {
  activeScreen: ActiveScreen;
  canOpenHomework: boolean;
  onLeaderboard: () => void;
  onHomework: () => void;
  onProfile: () => void;
}) {
  const homeworkActive = canOpenHomework && activeScreen === "homeworkUpload";

  return (
    <nav className="bottomNav" aria-label="Geeks Service">
      <button
        type="button"
        className={`bottomNavButton ${activeScreen === "leaderboard" ? "active" : ""}`}
        aria-label="Рейтинг"
        aria-current={activeScreen === "leaderboard" ? "page" : undefined}
        onClick={onLeaderboard}
      >
        <span className="navIcon navIconRank" aria-hidden="true"><i /><i /><i /></span>
      </button>
      <button
        type="button"
        className={`bottomNavButton bottomNavPrimary ${homeworkActive ? "active" : ""} ${canOpenHomework ? "" : "locked"}`}
        aria-label={canOpenHomework ? "Отправить ДЗ" : "Geeks"}
        aria-current={homeworkActive ? "page" : undefined}
        aria-disabled={!canOpenHomework}
        onClick={() => {
          if (canOpenHomework) onHomework();
        }}
      >
        {canOpenHomework ? (
          <span className="navIcon navIconHomework" aria-hidden="true"><span className="uploadArrow" /><strong>ДЗ</strong></span>
        ) : (
          <span className="navIcon navIconGeeks" aria-hidden="true"><img src="/geeks-lightning.svg" alt="" /></span>
        )}
      </button>
      <button
        type="button"
        className={`bottomNavButton ${activeScreen === "profile" ? "active" : ""}`}
        aria-label="Профиль"
        aria-current={activeScreen === "profile" ? "page" : undefined}
        onClick={onProfile}
      >
        <span className="navIcon navIconProfile" aria-hidden="true" />
      </button>
    </nav>
  );
}

const knownMissingTelegramAvatars = new Set(["akyl1230", "chinaronaldo"]);

function shouldUseAvatar(student: StudentView): student is StudentView & { avatarUrl: string } {
  if (!student.avatarUrl) return false;
  const username = student.telegramUsername?.toLowerCase();
  if (username && knownMissingTelegramAvatars.has(username)) return false;
  return true;
}

function Panel({ text }: { text: string }) {
  return <section className="panel">{text}</section>;
}

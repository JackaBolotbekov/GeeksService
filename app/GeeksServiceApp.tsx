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
  if (!response.ok) throw new Error(data?.message ?? "–û—à–∏–±–∫–∞ –∑–∞–ø—Ä–æ—Å–∞");
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
  if (!response.ok) throw new Error(data?.message ?? "–û—à–∏–±–∫–∞ –∑–∞–ø—Ä–æ—Å–∞");
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
  if (!response.ok) throw new Error(data?.message ?? "–û—à–∏–±–∫–∞ –∑–∞–≥—Ä—É–∑–∫–∏ —á–∞—Å—Ç–∏ —Ñ–∞–π–ª–∞");
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
  if (job.phase === "interrupted") return "–ó–∞–≥—Ä—É–∑–∫–∞ –æ—Å—Ç–∞–Ω–æ–≤–∏–ª–∞—Å—å –Ω–∞ —É—Å—Ç—Ä–æ–π—Å—Ç–≤–µ";
  if (job.phase === "paused") return "–ó–∞–≥—Ä—É–∑–∫–∞ –ø—Ä–∏–æ—Å—Ç–∞–Ω–æ–≤–ª–µ–Ω–∞";
  if (job.phase === "finalizing") return "YouTube –æ–±—Ä–∞–±–∞—Ç—ã–≤–∞–µ—Ç –≤–∏–¥–µ–æ";
  if (job.phase === "creating") return "–ì–æ—Ç–æ–≤–∏—Ç—Å—è –∑–∞–≥—Ä—É–∑–∫–∞";
  if (job.phase === "saving") return "–°–æ—Ö—Ä–∞–Ω—è–µ—Ç—Å—è –¥–æ–ø–º–∞—Ç–µ—Ä–∏–∞–ª";
  return "–í–∏–¥–µ–æ –∑–∞–≥—Ä—É–∂–∞–µ—Ç—Å—è –≤ YouTube";
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
  if (file.size <= 0) throw new Error("–í–∏–¥–µ–æ –ø—É—Å—Ç–æ–µ");

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
    const reconciled = await reconcileUpload().catch((€ﬁ∑Ú⁄$z{-ÆÈ‹j◊ùÂ7V&÷óC◊≤ÜWfVÁBí”‚∞–¢WfVÁBÁ&WfVÁDFVfV«BÇì∞–¢fˆñB7&VFU7GVFVÁBÇì∞–¢◊”‡–¢∆ñÁWBf«VS◊∂Fó7∆îÊ÷W“ˆ‰6ÜÊvS◊≤ÜWfVÁBí”‚6WDFó7∆îÊ÷RÜWfVÁBÁF&vWBÁf«VRó“∆6VÜˆ∆FW#“-	çÕÚ=}]›ç≠"Û‡–¢∆ñÁWBf«VS◊∑FV∆Vw&◊“ˆ‰6ÜÊvS◊≤ÜWfVÁBí”‚6WEFV∆Vw&“ÜWfVÁBÁF&vWBÁf«VRó“∆6VÜˆ∆FW#“$W6W&Ê÷RçΩÇFV∆Vw&“îB"Û‡–¢∆'WGFˆ‚GóS“'7V&÷óB"Fó6&∆VC◊∂'W7í«¬Fó7∆îÊ÷RÁG&ñ“Çó“&ñ÷'W7ì◊∂'W7ó”Ì	MÌ-ç-√¬ˆ'WGFˆ„‡–¢¬ˆf˜&”‡–¢¬˜6V7Fñˆ„‡–¢ì∞–ß––†–¶gVÊ7Fñˆ‚∆VFW&&ˆ&Bá∞–¢7GVFVÁG2¿–¢ó4F÷ñ‚¿–¢WáÊFVE7GVFVÁDñB¿–¢'V∆¥VFóD÷ˆFR¿–¢ˆ‰'V∆¥VFóD6∆˜6R¿–¢ˆÂFˆvv∆U7GVFVÁB¿–¢ˆÂ66˜&T6ÜÊvR¿–¢ˆ‰'V∆µ7GVFVÁD6ÜÊvR¿–ß”¢∞–¢7GVFVÁG3¢7GVFVÁEfñWuµ”∞–¢ó4F÷ñ„¢&ˆˆ∆V„∞–¢WáÊFVE7GVFVÁDñC¢7G&ñÊr¬ÁV∆√∞–¢'V∆¥VFóD÷ˆFS¢&ˆˆ∆V„∞–¢ˆ‰'V∆¥VFóD6∆˜6S¢Çí”‚fˆñC∞–¢ˆÂFˆvv∆U7GVFVÁC¢á7GVFVÁDñC¢7G&ñÊrí”‚fˆñC∞–¢ˆÂ66˜&T6ÜÊvS¢á7GVFVÁC¢7GVFVÁEfñWr¬∆W76ˆ‰ÁV÷&W#¢ÁV÷&W"¬66˜&S¢ÁV÷&W"¬ÁV∆¬í”‚&ˆ÷ó6S«fˆñC„∞–¢ˆ‰'V∆µ7GVFVÁD6ÜÊvS¢Ü6ÜÊvW3¢7GVFVÁD6ÜÊvUµ“í”‚&ˆ÷ó6S«fˆñC„∞–ß“í∞–¢6ˆÁ7B∂7FófT∆W76ˆ‚¬6WD7FófT∆W76ˆÂ““W6U7FFS«≤7GVFVÁDñC¢7G&ñÊs≤∆W76ˆ‰ÁV÷&W#¢ÁV÷&W"“¬ÁV∆√‚ÜÁV∆¬ì∞–¢6ˆÁ7B∑6fñÊt∂Wí¬6WE6fñÊt∂Wï““W6U7FFS«7G&ñÊr¬ÁV∆√‚ÜÁV∆¬ì∞–¢6ˆÁ7B∂'V∆¥G&gG2¬6WD'V∆¥G&gG5““W6U7FFS≈&V6˜&C«7G&ñÊr¬7GVFVÁDG&gC„‚á∑“ì∞–¢6ˆÁ7B∂'V∆µ6fñÊr¬6WD'V∆µ6fñÊu““W6U7FFRÜf«6Rì∞–†–¢6ˆÁ7BFˆvv∆U7GVFVÁDg&ˆ’&˜r“á7GVFVÁC¢7GVFVÁEfñWrí”‚∞–¢6WD7FófT∆W76ˆ‚ÜÁV∆¬ì∞–¢ˆÂFˆvv∆U7GVFVÁBá7GVFVÁBÊñBì∞–¢”∞–†–¢6ˆÁ7BÜÊF∆U7GVFVÁD∂WîF˜v‚“ÜWfVÁC¢&V7D∂Wñ&ˆ&DWfVÁCƒÖD‘ƒV∆V÷VÁC‚¬7GVFVÁC¢7GVFVÁEfñWrí”‚∞¢6ˆÁ7BF&vWB“WfVÁBÁF&vWB2ÖD‘ƒV∆V÷VÁC∞–¢ñbáF&vWBÊ6∆˜6W7BÇ&'WGFˆ‚∆ñÁWB«6V∆V7B"íí&WGW&„∞–¢ñbÜWfVÁBÊ∂Wí”“$VÁFW""bbWfVÁBÊ∂Wí”“""í&WGW&„∞–¢WfVÁBÁ&WfVÁDFVfV«BÇì∞–¢Fˆvv∆U7GVFVÁDg&ˆ’&˜rá7GVFVÁBì∞–¢”∞–†–¢6ˆÁ7B6fU66˜&R“7ñÊ2á7GVFVÁC¢7GVFVÁEfñWr¬∆W76ˆ‰ÁV÷&W#¢ÁV÷&W"¬66˜&S¢ÁV÷&W"¬ÁV∆¬í”‚∞–¢6ˆÁ7B∂Wí“G∑7GVFVÁBÊñG”¢G∂∆W76ˆ‰ÁV÷&W'÷∞–¢6WD7FófT∆W76ˆ‚ÜÁV∆¬ì∞–¢ÜFñ4ñ◊7BÇ&∆ñváB"ì∞–¢G'í∞–¢vñÊF˜rÁ6WEFñ÷V˜WBÇÇí”‚∞–¢6WE6fñÊt∂WíÇÜ7W'&VÁBí”‚7W'&VÁB””“∂WíÚÁV∆¬¢7W'&VÁBì∞–¢“¬##ì∞–¢6WE6fñÊt∂WíÜ∂Wíì∞–¢vóBˆÂ66˜&T6ÜÊvRá7GVFVÁB¬∆W76ˆ‰ÁV÷&W"¬66˜&Rì∞–¢ÜFñ4Ê˜Fñ6RÇ'7V66W72"ì∞–¢“6F6Ç∞–¢ÜFñ4Ê˜Fñ6RÇ&W'&˜""ì∞–¢6WD7FófT∆W76ˆ‚á≤7GVFVÁDñC¢7GVFVÁBÊñB¬∆W76ˆ‰ÁV÷&W"“ì∞–¢“fñÊ∆«í∞–¢6WE6fñÊt∂WíÜÁV∆¬ì∞–¢––¢”∞–†–¢6ˆÁ7BWFFT'V∆¥G&gB“á7GVFVÁC¢7GVFVÁEfñWr¬fñV∆C¢VFóDfñV∆B¬f«VS¢7G&ñÊrí”‚∞–¢6WD'V∆¥G&gG2ÇÜ7W'&VÁBí”‚á∞–¢‚‚Ê7W'&VÁB¿¢∑7GVFVÁBÊñE”¢∞¢‚‚‚Ü7W'&VÁE∑7GVFVÁBÊñE“ÛÚ∞¢Fó7∆îÊ÷S¢7GVFVÁBÊFó7∆îÊ÷R¿¢FV∆Vw&”¢FV∆Vw&‘G&gEf«VRá7GVFVÁBí¿¢“í¿¢∂fñV∆E”¢f«VR¿¢“¿¢“íì∞–¢”∞–†–¢6ˆÁ7B'V∆¥6ÜÊvW2“Çí”‚∞–¢6ˆÁ7B6ÜÊvW3¢7GVFVÁD6ÜÊvUµ““µ”∞–¢f˜"Ü6ˆÁ7B7GVFVÁBˆb7GVFVÁG2í∞–¢6ˆÁ7BG&gB“'V∆¥G&gG5∑7GVFVÁBÊñE“ÛÚ≤Fó7∆îÊ÷S¢7GVFVÁBÊFó7∆îÊ÷R¬FV∆Vw&”¢FV∆Vw&‘G&gEf«VRá7GVFVÁBí”∞–¢6ˆÁ7BF6Ç“'Vñ∆E7GVFVÁEF6Çá7GVFVÁB¬G&gBì∞–¢ñbáF6Çí6ÜÊvW2ÁW6Çá≤7GVFVÁB¬F6Ç“ì∞–¢––¢&WGW&‚6ÜÊvW3∞–¢”∞–†–¢6ˆÁ7B6fT'V∆¥6ÜÊvW2“7ñÊ2Çí”‚∞–¢∆WB6ÜÊvW3¢7GVFVÁD6ÜÊvUµ““µ”∞–¢G'í∞–¢6ÜÊvW2“'V∆¥6ÜÊvW2Çì∞–¢“6F6Ç∞–¢ÜFñ4Ê˜Fñ6RÇ&W'&˜""ì∞–¢&WGW&„∞–¢––¢ñbÜ6ÜÊvW2Ê∆VÊwFÇ””“í∞–¢ˆ‰'V∆¥VFóD6∆˜6RÇì∞–¢&WGW&„∞–¢––¢6WD'V∆µ6fñÊráG'VRì∞–¢G'í∞–¢vóBˆ‰'V∆µ7GVFVÁD6ÜÊvRÜ6ÜÊvW2ì∞–¢ÜFñ4Ê˜Fñ6RÇ'7V66W72"ì∞–¢ˆ‰'V∆¥VFóD6∆˜6RÇì∞–¢“6F6Ç∞–¢ÜFñ4Ê˜Fñ6RÇ&W'&˜""ì∞–¢“fñÊ∆«í∞–¢6WD'V∆µ6fñÊrÜf«6Rì∞–¢––¢”∞–†–¢∆WB'V∆¥6ÜÊvT6˜VÁB“∞–¢ñbÜ'V∆¥VFóD÷ˆFRí∞–¢G'í∞–¢'V∆¥6ÜÊvT6˜VÁB“'V∆¥6ÜÊvW2ÇíÊ∆VÊwFÉ∞–¢“6F6Ç∞–¢'V∆¥6ÜÊvT6˜VÁB“∞–¢––¢––†–¢ñbá7GVFVÁG2Ê∆VÊwFÇ””“í&WGW&‚≈ÊV¬FWáC“-	˝Ì≠›]"≠-ç-›ΩR=}]›ç≠Ì""Û„∞–¢&WGW&‚Ä–¢«6V7Fñˆ‚6∆74Ê÷S“&∆VFW&&ˆ&B#‡–¢∂'V∆¥VFóD÷ˆFRbbÄ–¢∆Fób6∆74Ê÷S“&'V∆¥7FñˆÁ2#‡–¢∆'WGFˆ‚GóS“&'WGFˆ‚"6∆74Ê÷S“&'V∆¥6Ê6V¬"Fó6&∆VC◊∂'V∆µ6fñÊw“ˆ‰6∆ñ6≥◊∂ˆ‰'V∆¥VFóD6∆˜6W”Ì	Ì-Õ]›¬ˆ'WGFˆ„‡–¢∆'WGFˆ‚GóS“&'WGFˆ‚"6∆74Ê÷S“&'V∆µ6fR"Fó6&∆VC◊∂'V∆µ6fñÊw“ˆ‰6∆ñ6≥◊≤Çí”‚fˆñB6fT'V∆¥6ÜÊvW2Çó”‡–¢∂'V∆µ6fñÊrÚ-
Ì]›˝‚‚‚‚"¢'V∆¥6ÜÊvT6˜VÁB‚Ú
Ì]›ç-¬G∂'V∆¥6ÜÊvT6˜VÁG÷¢-	=Ì-Ì-‚'––¢¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢ó––¢∑7GVFVÁG2Ê÷Çá7GVFVÁB¬ñÊFWÇí”‚∞–¢6ˆÁ7B'V∆¥G&gB“'V∆¥G&gG5∑7GVFVÁBÊñE“ÛÚ≤Fó7∆îÊ÷S¢7GVFVÁBÊFó7∆îÊ÷R¬FV∆Vw&”¢FV∆Vw&‘G&gEf«VRá7GVFVÁBí”∞–¢6ˆÁ7Bó4WáÊFVB“WáÊFVE7GVFVÁDñB””“7GVFVÁBÊñC∞–¢6ˆÁ7B7FófTf˜%7GVFVÁB“7FófT∆W76ˆ„ÚÁ7GVFVÁDñB””“7GVFVÁBÊñBÚ7FófT∆W76ˆ‚Ê∆W76ˆ‰ÁV÷&W"¢ÁV∆√∞–¢6ˆÁ7Bó56fñÊu7GVFVÁB“6fñÊt∂WìÚÁ7F'G5vóFÇÜG∑7GVFVÁBÊñG”¶íÛÚf«6S∞–¢ñbÜ'V∆¥VFóD÷ˆFRí∞–¢&WGW&‚Ä–¢∆'Fñ6∆P–¢6∆74Ê÷S◊∂7GVFVÁB'V∆¥VFóFñÊrG∑7GVFVÁBÊó47W'&VÁEW6W"Ú&7W'&VÁB"¢"'“G∂'V∆µ6fñÊrÚ'6fñÊr"¢"'÷––¢∂Wì◊∑7GVFVÁBÊñG––¢7Gñ∆S◊∑∞–¢"“◊&Ê≤#¢ñÊFWÇ¿–¢fñWuG&Á6óFñˆ‰Ê÷S¢7GVFVÁB“G∑7GVFVÁBÊñBÁ&W∆6RÇıµÊ◊£”ïÚ’“ˆví¬"“"ó÷¿–¢“2555&˜W'FñW7––¢‡–¢∆Fób6∆74Ê÷S“&'V∆µ7GVFVÁE&˜r#‡–¢ƒfF"7GVFVÁC◊∑7GVFVÁG“Û‡–¢∆Fób6∆74Ê÷S“&'V∆¥fñV∆G2#‡–¢∆ñÁW@–¢6∆74Ê÷S“&'V∆¥ñÁWB'V∆¥Ê÷R –¢f«VS◊∂'V∆¥G&gBÊFó7∆îÊ÷W––¢Fó6&∆VC◊∂'V∆µ6fñÊw––¢WFÙ6ˆ◊∆WFS“&ˆfb –¢WFÙ6˜'&V7C“&ˆfb –¢7V∆ƒ6ÜV6≥◊∂f«6W––¢ˆ‰fˆ7W3◊≤ÜWfVÁBí”‚fˆ7W4VFóF&∆TfñV∆DVÊBÜWfVÁBÊ7W'&VÁEF&vWBó––¢∆6VÜˆ∆FW#“-	çÕÚ –¢ˆ‰6ÜÊvS◊≤ÜWfVÁBí”‚WFFT'V∆¥G&gBá7GVFVÁB¬&Fó7∆îÊ÷R"¬WfVÁBÁF&vWBÁf«VRó––¢Û‡–¢∆ñÁW@–¢6∆74Ê÷S“&'V∆¥ñÁWB'V∆µFV∆Vw&“ –¢f«VS◊∂'V∆¥G&gBÁFV∆Vw&◊––¢Fó6&∆VC◊∂'V∆µ6fñÊw––¢∆6VÜˆ∆FW#“$W6W&Ê÷RçΩÇDrîB –¢ñÁWD÷ˆFS◊∂ó5FV∆Vw&‘ñBÜ'V∆¥G&gBÁFV∆Vw&“íÚ&ÁV÷W&ñ2"¢'FWáB'––¢WFÙ6ˆ◊∆WFS“&ˆfb –¢WFÙ6˜'&V7C“&ˆfb –¢7V∆ƒ6ÜV6≥◊∂f«6W––¢ˆ‰fˆ7W3◊≤ÜWfVÁBí”‚fˆ7W4VFóF&∆TfñV∆DVÊBÜWfVÁBÊ7W'&VÁEF&vWBó––¢ˆ‰6ÜÊvS◊≤ÜWfVÁBí”‚WFFT'V∆¥G&gBá7GVFVÁB¬'FV∆Vw&“"¬WfVÁBÁF&vWBÁf«VRó––¢Û‡–¢¬ˆFóc‡–¢¬ˆFóc‡–¢¬ˆ'Fñ6∆S‡–¢ì∞–¢––¢&WGW&‚Ä–¢∆'Fñ6∆P–¢6∆74Ê÷S◊∂7GVFVÁBG∑7GVFVÁBÊó47W'&VÁEW6W"Ú&7W'&VÁB"¢"'“G∂ó4WáÊFVBÚ&WáÊFVB"¢"'“G∂ó56fñÊu7GVFVÁBÚ'6fñÊr"¢"'÷––¢∂Wì◊∑7GVFVÁBÊñG––¢7Gñ∆S◊∑∞–¢"“◊&Ê≤#¢ñÊFWÇ¿–¢fñWuG&Á6óFñˆ‰Ê÷S¢7GVFVÁB“G∑7GVFVÁBÊñBÁ&W∆6RÇıµÊ◊£”ïÚ’“ˆví¬"“"ó÷¿–¢“2555&˜W'FñW7––¢‡–¢∆Fó`–¢6∆74Ê÷S“'7GVFVÁD÷ñ‚ –¢&ˆ∆S“&'WGFˆ‚ –¢F$ñÊFWÉ◊≥––¢&ñ÷WáÊFVC◊∂ó4WáÊFVG––¢ˆ‰6∆ñ6≥◊≤ÜWfVÁBí”‚∞–¢6ˆÁ7BF&vWB“WfVÁBÁF&vWB2ÖD‘ƒV∆V÷VÁC∞–¢ñbáF&vWBÊ6∆˜6W7BÇ&'WGFˆ‚∆ñÁWB«6V∆V7B"íí&WGW&„∞–¢Fˆvv∆U7GVFVÁDg&ˆ’&˜rá7GVFVÁBì∞–¢◊––¢ˆ‰∂WîF˜v„◊≤ÜWfVÁBí”‚ÜÊF∆U7GVFVÁD∂WîF˜v‚ÜWfVÁB¬7GVFVÁBó––¢‡–¢«7‚6∆74Ê÷S“'∆6R#Á∑7GVFVÁBÁ∆6W”¬˜7„‡–¢ƒfF"7GVFVÁC◊∑7GVFVÁG“6Ü˜t÷VF¬Û‡–¢∆Fób6∆74Ê÷S“'7GVFVÁDñÊfÚ#‡–¢«7G&ˆÊsÁ∑7GVFVÁBÊFó7∆îÊ÷W”¬˜7G&ˆÊs‡–¢«7„Á∂Üˆ÷Wv˜&¥∆&V¬á7GVFVÁBÊ6ˆ◊∆WFVD∆W76ˆÁ2ó”¬˜7„‡–¢¬ˆFóc‡–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S“&FV«F –¢&ñ÷WáÊFVC◊∂ó4WáÊFVG––¢ˆ‰6∆ñ6≥◊≤Çí”‚∞–¢6WD7FófT∆W76ˆ‚ÜÁV∆¬ì∞–¢ˆÂFˆvv∆U7GVFVÁBá7GVFVÁBÊñBì∞–¢◊––¢‡–¢∑7GVFVÁBÁF˜F≈66˜&W––¢¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢∆Fób6∆74Ê÷S“&∆W76ˆÂF'2"&ñ÷∆&V√◊∂	ΩΩ≤}"MÌÕç]£¢G∑7GVFVÁBÊFó7∆îÊ÷W÷”‡–¢∑7GVFVÁBÁ66˜&W2Ê÷ÇÜ6V∆¬í”‚Ä–¢«7‡–¢6∆74Ê÷S◊∂∆W76ˆÂF"G∂6V∆¬Á66˜&R””“ÁV∆¬Ú""¢&fñ∆∆VB'÷––¢∂Wì◊∂6V∆¬Ê∆W76ˆ‰ÁV÷&W'––¢FóF∆S◊∂	M	rG∂6V∆¬Ê∆W76ˆ‰ÁV÷&W'”¢G∂6V∆¬Á66˜&RÛÚ.(	B'÷––¢‡–¢«7G&ˆÊsÁ∂6V∆¬Á66˜&RÛÚ6V∆¬Ê∆W76ˆ‰ÁV÷&W'”¬˜7G&ˆÊs‡–¢¬˜7„‡–¢íó––¢¬ˆFóc‡–¢∂WáÊFVE7GVFVÁDñB””“7GVFVÁBÊñBbbÄ–¢∆Fób6∆74Ê÷S“&∆W76ˆ‰VFóF˜"#‡–¢∆Fób6∆74Ê÷S“&∆W76ˆ‰w&ñB#‡–¢∑7GVFVÁBÁ66˜&W2Ê÷ÇÜ6V∆¬í”‚∞–¢&WGW&‚Ä–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S◊∂∆W76ˆ‰6ÜóG∂6V∆¬Á66˜&R””“ÁV∆¬Ú""¢&fñ∆∆VB'“G∂7FófTf˜%7GVFVÁB””“6V∆¬Ê∆W76ˆ‰ÁV÷&W"Ú&7FófR"¢"'÷––¢∂Wì◊∂6V∆¬Ê∆W76ˆ‰ÁV÷&W'––¢Fó6&∆VC◊≤ó4F÷ñÁ––¢ˆ‰6∆ñ6≥◊≤Çí”‚∞–¢ÜFñ56V∆V7Fñˆ‚Çì∞–¢6WD7FófT∆W76ˆ‚ÇÜ7W'&VÁBí”‡–¢7W'&VÁCÚÁ7GVFVÁDñB””“7GVFVÁBÊñBbb7W'&VÁBÊ∆W76ˆ‰ÁV÷&W"””“6V∆¬Ê∆W76ˆ‰ÁV÷&W –¢ÚÁV∆¿–¢¢≤7GVFVÁDñC¢7GVFVÁBÊñB¬∆W76ˆ‰ÁV÷&W#¢6V∆¬Ê∆W76ˆ‰ÁV÷&W"“¿–¢ì∞–¢◊––¢‡–¢«7G&ˆÊsÁ∂6V∆¬Á66˜&RÛÚ6V∆¬Ê∆W76ˆ‰ÁV÷&W'”¬˜7G&ˆÊs‡–¢¬ˆ'WGFˆ„‡–¢ì∞–¢“ó––¢¬ˆFóc‡–¢∂ó4F÷ñ‚bb7FófTf˜%7GVFVÁBbbÄ–¢∆Fób6∆74Ê÷S“'66˜&Uñ6∂W"#‡–¢¥'&íÊg&ˆ“á≤∆VÊwFÉ¢“¬ÖÚ¬ñÊFWÇí”‚ñÊFWÇ≤íÊ÷Çá66˜&Rí”‚Ä–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S“'66˜&T˜Fñˆ‚ –¢∂Wì◊∑66˜&W––¢Fó6&∆VC◊∑6fñÊt∂Wí””“G∑7GVFVÁBÊñG”¢G∂7FófTf˜%7GVFVÁG÷––¢ˆ‰6∆ñ6≥◊≤Çí”‚fˆñB6fU66˜&Rá7GVFVÁB¬7FófTf˜%7GVFVÁB¬66˜&Ró––¢‡–¢∑66˜&W––¢¬ˆ'WGFˆ„‡–¢íó––¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S“'66˜&T6∆V" –¢Fó6&∆VC◊∑6fñÊt∂Wí””“G∑7GVFVÁBÊñG”¢G∂7FófTf˜%7GVFVÁG÷––¢ˆ‰6∆ñ6≥◊≤Çí”‚fˆñB6fU66˜&Rá7GVFVÁB¬7FófTf˜%7GVFVÁB¬ÁV∆¬ó––¢‡–¢9p–¢¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢ó––¢¬ˆFóc‡–¢ó––¢¬ˆ'Fñ6∆S‡–¢ì∞–¢“ó––¢¬˜6V7Fñˆ„‡–¢ì∞–ß––†–¶gVÊ7Fñˆ‚fF"á≤7GVFVÁB¬6Ü˜t÷VF¬“f«6R”¢≤7GVFVÁC¢7GVFVÁEfñWs≤6Ü˜t÷VF√Û¢&ˆˆ∆V‚“í∞–¢6ˆÁ7B∂fñ∆VB¬6WDfñ∆VE““W6U7FFRÜf«6Rì∞–¢6ˆÁ7BñÊóFñ¬“7GVFVÁBÊFó7∆îÊ÷P–¢Á7∆óBÇı«2≤Úê–¢Êfñ«FW"Ñ&ˆˆ∆V‚ê–¢ÊBÉê–¢ÚÊBÉê–¢ÚÁFıWW$66RÇì∞–¢6ˆÁ7B÷VF¬“6Ü˜t÷VF¬bb7GVFVÁBÁ∆6RÚˆFóV‘÷VF¬á7GVFVÁBÁ∆6Rí¢ÁV∆√∞¢6ˆÁ7BfF"“6Ü˜V∆EW6TfF"á7GVFVÁBíbbfñ∆V@–¢Ú∆ñ÷r6∆74Ê÷S“&fF""7&3◊∑7GVFVÁBÊfF%W&«“«C“""ˆ‰W'&˜#◊≤Çí”‚6WDfñ∆VBáG'VRó“Û‡–¢¢«7‚6∆74Ê÷S“&fF"f∆∆&6≤#Á∂ñÊóFñ¬«¬$r'”¬˜7„„∞–†–¢&WGW&‚Ä–¢«7‚6∆74Ê÷S◊∂fF%w&G∂÷VF¬Ú'vóFÑ÷VF¬"¢"'÷”‡–¢∂fF'––¢∂÷VF¬bbÄ–¢«7‚6∆74Ê÷S◊∂ˆFóV‘÷VF¬G∂÷VF¬Ê∂ñÊG÷“&ñ÷∆&V√◊∂÷VF¬Ê∆&V«“FóF∆S◊∂÷VF¬Ê∆&V«”‡–¢«7‚6∆74Ê÷S“&÷VFƒ&ÊB∆VgB"&ñ÷ÜñFFV„“'G'VR"Û‡–¢«7‚6∆74Ê÷S“&÷VFƒ&ÊB&ñváB"&ñ÷ÜñFFV„“'G'VR"Û‡–¢«7‚6∆74Ê÷S“&÷VFƒ&FvR#Á∂÷VF¬Á∆6W”¬˜7„‡–¢¬˜7„‡–¢ó––¢¬˜7„‡–¢ì∞–ß––†–¶gVÊ7Fñˆ‚ˆFóV‘÷VF¬á∆6S¢ÁV÷&W"í∞–¢ñbá∆6R””“í&WGW&‚≤∆6R¬∂ñÊC¢&vˆ∆B"¬∆&V√¢#Õ]-‚"”∞–¢ñbá∆6R””“"í&WGW&‚≤∆6R¬∂ñÊC¢'6ñ«fW""¬∆&V√¢#"Õ]-‚"”∞–¢ñbá∆6R””“2í&WGW&‚≤∆6R¬∂ñÊC¢&'&ˆÁ¶R"¬∆&V√¢#2Õ]-‚"”∞–¢&WGW&‚ÁV∆√∞–ß––†–¶gVÊ7Fñˆ‚&˜GFˆ‘Êbá∞–¢7FófU67&VV‚¿–¢6‰˜V‰Üˆ÷Wv˜&≤¿–¢ˆ‰∆VFW&&ˆ&B¿–¢ˆ‰Üˆ÷Wv˜&≤¿–¢ˆÂ&ˆfñ∆R¿–ß”¢∞–¢7FófU67&VV„¢7FófU67&VV„∞–¢6‰˜V‰Üˆ÷Wv˜&≥¢&ˆˆ∆V„∞–¢ˆ‰∆VFW&&ˆ&C¢Çí”‚fˆñC∞–¢ˆ‰Üˆ÷Wv˜&≥¢Çí”‚fˆñC∞–¢ˆÂ&ˆfñ∆S¢Çí”‚fˆñC∞–ß“í∞–¢6ˆÁ7BÜˆ÷Wv˜&¥7FófR“6‰˜V‰Üˆ÷Wv˜&≤bb7FófU67&VV‚””“&Üˆ÷Wv˜&µW∆ˆB#∞–†–¢&WGW&‚Ä–¢∆Êb6∆74Ê÷S“&&˜GFˆ‘Êb"&ñ÷∆&V√“$vVV∑26W'fñ6R#‡–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S◊∂&˜GFˆ‘Êd'WGFˆ‚G∂7FófU67&VV‚””“&∆VFW&&ˆ&B"Ú&7FófR"¢"'÷––¢&ñ÷∆&V√“-
]ù-ç›2 –¢&ñ÷7W'&VÁC◊∂7FófU67&VV‚””“&∆VFW&&ˆ&B"Ú'vR"¢VÊFVfñÊVG––¢ˆ‰6∆ñ6≥◊∂ˆ‰∆VFW&&ˆ&G––¢‡–¢«7‚6∆74Ê÷S“&Êdñ6ˆ‚Êdñ6ˆÂ&Ê≤"&ñ÷ÜñFFV„“'G'VR#„∆íÛ„∆íÛ„∆íÛ„¬˜7„‡–¢¬ˆ'WGFˆ„‡–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S◊∂&˜GFˆ‘Êd'WGFˆ‚&˜GFˆ‘Êe&ñ÷'íG∂Üˆ÷Wv˜&¥7FófRÚ&7FófR"¢"'“G∂6‰˜V‰Üˆ÷Wv˜&≤Ú""¢&∆ˆ6∂VB'÷––¢&ñ÷∆&V√◊∂6‰˜V‰Üˆ÷Wv˜&≤Ú-	Ì-˝-ç-¬	M	r"¢$vVV∑2'––¢&ñ÷7W'&VÁC◊∂Üˆ÷Wv˜&¥7FófRÚ'vR"¢VÊFVfñÊVG––¢&ñ÷Fó6&∆VC◊≤6‰˜V‰Üˆ÷Wv˜&∑––¢ˆ‰6∆ñ6≥◊≤Çí”‚∞–¢ñbÜ6‰˜V‰Üˆ÷Wv˜&≤íˆ‰Üˆ÷Wv˜&≤Çì∞–¢◊––¢‡–¢∂6‰˜V‰Üˆ÷Wv˜&≤ÚÄ–¢«7‚6∆74Ê÷S“&Êdñ6ˆ‚Êdñ6ˆ‰Üˆ÷Wv˜&≤"&ñ÷ÜñFFV„“'G'VR#„«7‚6∆74Ê÷S“'W∆ˆD'&˜r"Û„«7G&ˆÊsÌ	M	s¬˜7G&ˆÊs„¬˜7„‡–¢í¢Ä–¢«7‚6∆74Ê÷S“&Êdñ6ˆ‚Êdñ6ˆ‰vVV∑2"&ñ÷ÜñFFV„“'G'VR#„∆ñ÷r7&3“"ˆvVV∑2÷∆ñváFÊñÊrÁ7fr"«C“""Û„¬˜7„‡–¢ó––¢¬ˆ'WGFˆ„‡–¢∆'WGFˆ‡–¢GóS“&'WGFˆ‚ –¢6∆74Ê÷S◊∂&˜GFˆ‘Êd'WGFˆ‚G∂7FófU67&VV‚””“'&ˆfñ∆R"Ú&7FófR"¢"'÷––¢&ñ÷∆&V√“-	˝ÌMçΩ¬ –¢&ñ÷7W'&VÁC◊∂7FófU67&VV‚””“'&ˆfñ∆R"Ú'vR"¢VÊFVfñÊVG––¢ˆ‰6∆ñ6≥◊∂ˆÂ&ˆfñ∆W––¢‡–¢«7‚6∆74Ê÷S“&Êdñ6ˆ‚Êdñ6ˆÂ&ˆfñ∆R"&ñ÷ÜñFFV„“'G'VR"Û‡–¢¬ˆ'WGFˆ„‡–¢¬ˆÊc‡–¢ì∞–ß––†–¶6ˆÁ7B∂Ê˜v‰÷ó76ñÊuFV∆Vw&‘fF'2“ÊWr6WBÖ≤&∑ñ√#3"¬&6ÜñÊ&ˆÊ∆FÚ%“ì∞–†–¶gVÊ7Fñˆ‚6Ü˜V∆EW6TfF"á7GVFVÁC¢7GVFVÁEfñWrì¢7GVFVÁBó27GVFVÁEfñWrb≤fF%W&√¢7G&ñÊr“∞–¢ñbÇ7GVFVÁBÊfF%W&¬í&WGW&‚f«6S∞–¢6ˆÁ7BW6W&Ê÷R“7GVFVÁBÁFV∆Vw&’W6W&Ê÷SÚÁFÙ∆˜vW$66RÇì∞–¢ñbáW6W&Ê÷Rbb∂Ê˜v‰÷ó76ñÊuFV∆Vw&‘fF'2ÊÜ2áW6W&Ê÷Ríí&WGW&‚f«6S∞–¢&WGW&‚G'VS∞–ß––†–¶gVÊ7Fñˆ‚ÊV¬á≤FWáB”¢≤FWáC¢7G&ñÊr“í∞–¢&WGW&‚«6V7Fñˆ‚6∆74Ê÷S“'ÊV¬#Á∑FWáG”¬˜6V7Fñˆ„„∞–ß––
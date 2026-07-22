"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { bishkekDateKey, buildScheduleResponse, DEFAULT_LESSON_SCHEDULE, localDateParts } from "@/lib/schedule";
import type { AdminStudentsResponse, AuthResponse, HomeworkSubmitResponse, LeaderboardResponse, LessonScheduleInput, MeResponse, ScheduleResponse, StudentView } from "@/lib/types";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type LoadState = "loading" | "ready" | "error";
type ActiveScreen = "leaderboard" | "homeworkUpload" | "profile";
type UploadPhase = "idle" | "creating" | "uploading" | "done" | "error";
type HomeworkSubmitPhase = "idle" | "submitting" | "done" | "error";

type YouTubeUploadSessionResponse = {
  uploadUrl: string;
  accessToken: string;
  expiresIn: number;
  privacyStatus: "private" | "public" | "unlisted";
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

const VIDEO_CHUNK_SIZE = 16 * 1024 * 1024;
const LEADERBOARD_CACHE_KEY = "geeks-service:leaderboard:v1";
const LEADERBOARD_LIVE_INTERVAL_MS = 1400;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function uploadFileToYouTube({
  file,
  uploadUrl,
  accessToken,
  onProgress,
}: {
  file: File;
  uploadUrl: string;
  accessToken: string;
  onProgress: (progress: number) => void;
}): Promise<string> {
  if (file.size <= 0) throw new Error("Видео пустое");

  let offset = 0;
  let videoId: string | null = null;
  while (offset < file.size) {
    const end = Math.min(offset + VIDEO_CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, end, file.type || "application/octet-stream");
    const result = await uploadYouTubeChunkWithRetry({
      uploadUrl,
      accessToken,
      chunk,
      start: offset,
      end,
      total: file.size,
      mimeType: file.type || "application/octet-stream",
      onProgress: (loaded) => onProgress(Math.min(99, Math.round(((offset + loaded) / file.size) * 100))),
    });
    offset = end;
    if (result.videoId) videoId = result.videoId;
  }

  onProgress(100);
  if (!videoId) throw new Error("YouTube не вернул ID видео");
  return videoId;
}

async function uploadYouTubeChunkWithRetry(input: UploadChunkInput): Promise<{ videoId: string | null }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await uploadYouTubeChunk(input);
    } catch (error) {
      lastError = error;
      if (!isRetriableUploadError(error) || attempt === 2) break;
      await sleep(700 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Не удалось загрузить видео в YouTube");
}

function isRetriableUploadError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: number }).status)
    : 0;
  return status === 0 || [500, 502, 503, 504].includes(status);
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
}: UploadChunkInput): Promise<{ videoId: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${end - 1}/${total}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onerror = () => {
      const error = new Error("Не удалось загрузить кусок видео в YouTube") as Error & { status: number };
      error.status = 0;
      reject(error);
    };
    xhr.onload = () => {
      if (xhr.status === 308) {
        resolve({ videoId: null });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || "{}") as { id?: string };
          resolve({ videoId: data.id ?? null });
        } catch {
          reject(new Error("YouTube вернул некорректный ответ после загрузки"));
        }
        return;
      }
      const error = new Error(`YouTube upload error ${xhr.status}`) as Error & { status: number };
      error.status = xhr.status;
      reject(error);
    };
    xhr.send(chunk);
  });
}

function useLockedViewportZoom() {
  useEffect(() => {
    const options: AddEventListenerOptions = { passive: false };
    const preventZoomGesture: EventListener = (event) => {
      event.preventDefault();
    };
    const preventKeyboardZoom = (event: KeyboardEvent) => {
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
  const labels = ["VibeCoding-1", label];
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
      setSchedule((current) => buildScheduleResponse(current.lessons.length > 0 ? current.lessons : DEFAULT_LESSON_SCHEDULE));
    }, 30000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (state !== "ready" || activeScreen !== "leaderboard") return;
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
  }, [activeScreen, isAdmin, sessionToken, state]);

  useEffect(() => {
    const run = async () => {
      try {
        const telegramWebApp = await waitForTelegramWebApp();
        telegramWebApp?.ready?.();
        telegramWebApp?.expand?.();
        const initData = telegramWebApp?.initData;
        if (initData) {
          const auth = await api<AuthResponse>("/api/auth/telegram", {
            method: "POST",
            body: JSON.stringify({ initData }),
          });
          setSessionToken(auth.sessionToken);
          setIsAdmin(auth.profile.isAdmin);
          const me = await api<MeResponse>("/api/me", {}, auth.sessionToken);
          setIsPending(me.pending);
          await refresh(auth.sessionToken, auth.profile.isAdmin);
        } else {
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

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <img className="bolt" src="/geeks-lightning.svg" alt="" />
          <span>GEEKS<span>Service</span></span>
        </div>
        <div className="topActions">
          <ScheduleBadge label={schedule.currentLabel} />
          {isAdmin && sessionToken && (
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
          {activeScreen === "homeworkUpload" ? (
            <HomeworkUploadScreen
              isAdmin={isAdmin && Boolean(sessionToken)}
              sessionToken={sessionToken}
            />
          ) : activeScreen === "profile" ? (
            <ProfileScreen
              schedule={schedule}
              scheduleError={scheduleError}
              isAdmin={isAdmin && Boolean(sessionToken)}
              sessionToken={sessionToken}
              onScheduleChange={(next) => {
                setSchedule(next);
                setScheduleError(null);
              }}
            />
          ) : (
            <>
              {isAdmin && sessionToken && showAdminPanel && (
                <AdminPanel
                  sessionToken={sessionToken}
                  onChange={applyAdminResponse}
                />
              )}
              <Leaderboard
                students={leaderboard}
                isAdmin={isAdmin && Boolean(sessionToken)}
                expandedStudentId={expandedStudentId}
                bulkEditMode={bulkEditMode}
                onBulkEditClose={() => {
                  setBulkEditMode(false);
                }}
                onToggleStudent={toggleStudent}
                onScoreChange={async (student, lessonNumber, score) => {
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
                  if (!sessionToken || changes.length === 0) return;
                  const previous = leaderboardRef.current;
                  setLeaderboardSmooth((current) => {
                    const patchesById = new Map(changes.map((change) => [change.student.id, change.patch]));
                    return rankVisibleStudents(current.map((item) => {
                      const patch = patchesById.get(item.id);
                      return patch ? mergeStudentPatch(item, patch) : item;
                    }));
                  });
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
          )}
          <BottomNav
            activeScreen={activeScreen}
            onLeaderboard={() => {
              hapticSelection();
              setActiveScreen("leaderboard");
            }}
            onHomework={() => {
              hapticImpact("light");
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
  sessionToken,
  onScheduleChange,
}: {
  schedule: ScheduleResponse;
  scheduleError: string | null;
  isAdmin: boolean;
  sessionToken: string | null;
  onScheduleChange: (next: ScheduleResponse) => void;
}) {
  const [monthIndex, setMonthIndex] = useState(() => initialScheduleMonthIndex(schedule));
  const [editing, setEditing] = useState(false);
  const [monthMotion, setMonthMotion] = useState<"prev" | "next" | "idle">("idle");
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const months = schedule.months;
  const safeMonthIndex = Math.min(Math.max(monthIndex, 0), Math.max(0, months.length - 1));
  const currentMonth = months[safeMonthIndex] ?? months[0] ?? null;

  const navigateMonth = (step: -1 | 1) => {
    setMonthIndex((current) => {
      const next = Math.min(Math.max(current + step, 0), Math.max(0, months.length - 1));
      if (next !== current) {
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
    navigateMonth(dx < 0 ? 1 : -1);
  };

  return (
    <section className="profileScreen">
      <div className="calendarHero">
        <div className="calendarTopline">
          <span>Длительность обучения: 1 мес. 12 уроков</span>
          {isAdmin && (
            <button
              type="button"
              className="calendarEditButton"
              aria-expanded={editing}
              aria-label={editing ? "Закрыть настройку календаря" : "Настроить календарь"}
              onClick={() => {
                hapticImpact("light");
                setEditing((current) => !current);
              }}
            >
              ✎
            </button>
          )}
        </div>

        {currentMonth && (
          <div
            className="calendarCard"
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
              <strong>{currentMonth.label}</strong>
            </div>
            <div className={`calendarMonthPane ${monthMotion}`} key={currentMonth.key} onAnimationEnd={() => setMonthMotion("idle")}>
              <CalendarMonth month={currentMonth} lessons={schedule.lessons} />
            </div>
            {months.length > 1 && (
              <div className="calendarSwipeHint" aria-hidden="true">
                <span>‹</span>
                <strong>свайп</strong>
                <span>›</span>
              </div>
            )}
          </div>
        )}

        {scheduleError && <p className="calendarNote error">{scheduleError}</p>}
      </div>

      {editing && isAdmin && sessionToken && (
        <ScheduleEditor
          schedule={schedule}
          sessionToken={sessionToken}
          onSaved={(next) => {
            onScheduleChange(next);
            setEditing(false);
            setMonthIndex(initialScheduleMonthIndex(next));
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </section>
  );
}

function CalendarMonth({
  month,
  lessons,
}: {
  month: { key: string; year: number; month: number; label: string };
  lessons: ScheduleResponse["lessons"];
}) {
  const today = bishkekDateKey();
  const transferDates = new Set(["2026-07-17"]);
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
        const isTransfer = transferDates.has(key);
        return (
          <span
            className={`calendarDay ${mainLesson ? "lesson" : ""} ${mainLesson && !completed ? "upcoming" : ""} ${completed ? "completed" : ""} ${isTransfer ? "transfer" : ""} ${key === today ? "today" : ""}`}
            key={key}
            title={isTransfer ? "Перенос" : mainLesson ? `Урок ${mainLesson.lessonNumber}` : undefined}
          >
            <strong>{cell}</strong>
            {mainLesson && <small className="calendarLessonBadge">{mainLesson.lessonNumber}</small>}
            {isTransfer && <small className="calendarLessonBadge transferBadge">перенос</small>}
          </span>
        );
      })}
    </div>
  );
}

function ScheduleEditor({
  schedule,
  sessionToken,
  onSaved,
  onCancel,
}: {
  schedule: ScheduleResponse;
  sessionToken: string;
  onSaved: (next: ScheduleResponse) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState(() => schedule.lessons.map(scheduleDraft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const lessons: LessonScheduleInput[] = drafts.map((draft) => ({
        lessonNumber: draft.lessonNumber,
        scheduledAt: datetimeLocalToBishkekIso(draft.localValue),
        courseMonth: draft.courseMonth,
      }));
      const response = await api<ScheduleResponse>("/api/admin/schedule", {
        method: "PUT",
        body: JSON.stringify({ lessons }),
      }, sessionToken);
      hapticNotice("success");
      onSaved(response);
    } catch (caught) {
      hapticNotice("error");
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить расписание");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scheduleEditor">
      <div className="scheduleEditorGrid">
        {drafts.map((draft) => (
          <label className="scheduleLessonField" key={draft.lessonNumber}>
            <span>{draft.lessonNumber}</span>
            <input
              type="datetime-local"
              value={draft.localValue}
              disabled={saving}
              onChange={(event) => {
                const localValue = event.target.value;
                setDrafts((current) => current.map((item) =>
                  item.lessonNumber === draft.lessonNumber ? { ...item, localValue } : item,
                ));
              }}
            />
          </label>
        ))}
      </div>
      {error && <p className="calendarNote error">{error}</p>}
      <div className="scheduleActions">
        <button type="button" className="uploadSecondary" disabled={saving} onClick={onCancel}>Отмена</button>
        <button type="button" className="uploadPrimary" disabled={saving} onClick={() => void save()}>
          {saving ? "Сохраняю..." : "Сохранить"}
        </button>
      </div>
    </div>
  );
}

function scheduleDraft(lesson: ScheduleResponse["lessons"][number]) {
  return {
    lessonNumber: lesson.lessonNumber,
    localValue: lesson.scheduledAt.slice(0, 16),
    courseMonth: lesson.courseMonth,
  };
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

function calendarCells(year: number, month: number): Array<number | null> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leading = (firstDay + 6) % 7;
  const cells: Array<number | null> = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length < 42) cells.push(null);
  return cells;
}

function HomeworkUploadScreen({
  isAdmin,
  sessionToken,
}: {
  isAdmin: boolean;
  sessionToken: string | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const homeworkInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const busy = phase === "creating" || phase === "uploading";
  const [homeworkFile, setHomeworkFile] = useState<File | null>(null);
  const [homeworkLinks, setHomeworkLinks] = useState("");
  const [homeworkDescription, setHomeworkDescription] = useState("");
  const [homeworkDragActive, setHomeworkDragActive] = useState(false);
  const [homeworkPhase, setHomeworkPhase] = useState<HomeworkSubmitPhase>("idle");
  const [homeworkMessage, setHomeworkMessage] = useState<string | null>(null);
  const homeworkBusy = homeworkPhase === "submitting";
  const hasHomeworkContent = Boolean(homeworkLinks.trim() || homeworkDescription.trim() || homeworkFile);

  const selectFile = (nextFile: File | null) => {
    if (!nextFile) return;
    setFile(nextFile);
    setResultUrl(null);
    setUploadError(null);
    setProgress(0);
    if (!title.trim()) setTitle(fileTitle(nextFile));
  };

  const submitUpload = async () => {
    if (!isAdmin || !sessionToken || !file || !title.trim() || busy) return;
    setUploadError(null);
    setResultUrl(null);
    setProgress(0);
    setPhase("creating");
    try {
      const session = await api<YouTubeUploadSessionResponse>("/api/admin/youtube/upload-session", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          privacyStatus: "unlisted",
        }),
      }, sessionToken);

      setPhase("uploading");
      const videoId = await uploadFileToYouTube({
        file,
        uploadUrl: session.uploadUrl,
        accessToken: session.accessToken,
        onProgress: setProgress,
      });
      setResultUrl(`https://youtu.be/${videoId}`);
      setPhase("done");
      hapticNotice("success");
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "Не удалось загрузить видео");
      setPhase("error");
      hapticNotice("error");
    }
  };

  const selectHomeworkFile = (nextFile: File | null) => {
    if (!nextFile) return;
    setHomeworkFile(nextFile);
    setHomeworkMessage(null);
    setHomeworkPhase("idle");
  };

  const submitHomework = async () => {
    if (!sessionToken || homeworkBusy || !hasHomeworkContent) return;
    if (!homeworkLinksAreValid(homeworkLinks)) {
      setHomeworkPhase("error");
      setHomeworkMessage("В ссылках оставь URL, сайт или @username. Лучше по одной строке.");
      hapticNotice("warning");
      return;
    }
    setHomeworkPhase("submitting");
    setHomeworkMessage(null);
    try {
      const form = new FormData();
      form.set("links", homeworkLinks.trim());
      form.set("description", homeworkDescription.trim());
      form.set("extra", "");
      if (homeworkFile) form.set("file", homeworkFile);
      const result = await apiForm<HomeworkSubmitResponse>("/api/homework/submit", form, sessionToken);
      setHomeworkLinks("");
      setHomeworkDescription("");
      setHomeworkFile(null);
      setHomeworkPhase("done");
      setHomeworkMessage(result.fileName ? `ДЗ отправлено: ${result.fileName}` : "ДЗ отправлено");
      hapticNotice("success");
    } catch (caught) {
      setHomeworkPhase("error");
      setHomeworkMessage(caught instanceof Error ? caught.message : "Не удалось отправить ДЗ");
      hapticNotice("error");
    }
  };

  if (!isAdmin || !sessionToken) {
    return (
      <section className="uploadScreen">
        <form className="homeworkCard" onSubmit={(event) => {
          event.preventDefault();
          void submitHomework();
        }}>
          {!sessionToken && (
            <p className="uploadMessage error">
              Открой через Telegram, чтобы ДЗ привязалось к твоему профилю.
            </p>
          )}

          <label className="uploadField">
            <textarea
              className="compactTextarea homeworkLinksInput"
              value={homeworkLinks}
              disabled={homeworkBusy}
              maxLength={5000}
              aria-label="Ссылки на домашнее задание"
              placeholder="Ссылки: github.com/..., @Sites, @telegram_bot"
              onChange={(event) => setHomeworkLinks(event.target.value)}
            />
          </label>

          <label className="uploadField">
            <textarea
              value={homeworkDescription}
              disabled={homeworkBusy}
              maxLength={5000}
              aria-label="Описание домашнего задания"
              placeholder="Что именно ты сдаёшь и что нужно проверить. Можешь дополнить от себя.."
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
              accept=".md,.markdown,.zip,.pdf,.txt,.doc,.docx,image/*,video/*"
              disabled={homeworkBusy}
              onChange={(event) => selectHomeworkFile(event.target.files?.item(0) ?? null)}
            />
            <span className="dropIcon">↑</span>
            <strong>{homeworkFile ? homeworkFile.name : "нажми или перетащи"}</strong>
            <small>{homeworkFile ? formatBytes(homeworkFile.size) : ".md .zip"}</small>
          </label>

          {homeworkMessage && <p className={`uploadMessage ${homeworkPhase === "error" ? "error" : "success"}`}>{homeworkMessage}</p>}

          <div className="uploadActions homeworkSubmitActions">
            <button type="submit" className="uploadPrimary" disabled={homeworkBusy || !sessionToken || !hasHomeworkContent}>
              {homeworkBusy ? "Отправляю..." : "Отправить"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="uploadScreen">
      <form className="uploadCard teacherUploadCard" onSubmit={(event) => {
        event.preventDefault();
        void submitUpload();
      }}>
        <label
          className={`dropZone ${dragActive ? "active" : ""} ${file ? "hasFile" : ""}`}
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
            disabled={busy}
            onChange={(event) => selectFile(event.target.files?.item(0) ?? null)}
          />
          <span className="dropIcon">↑</span>
          <strong>{file ? file.name : "Перетащи видео сюда"}</strong>
          <small>{file ? `${file.type || "video"} · ${formatBytes(file.size)}` : "или нажми, чтобы выбрать MP4 / MOV / WEBM"}</small>
        </label>

        <label className="uploadField">
          <span>Название ролика</span>
          <input
            value={title}
            disabled={busy}
            maxLength={100}
            placeholder="Например: Урок 6 · домашнее задание"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="uploadField">
          <span>Описание и домашнее задание</span>
          <textarea
            value={description}
            disabled={busy}
            maxLength={5000}
            placeholder="Опиши тему урока, дедлайн, что сдать ученикам и ссылки."
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <div className="uploadMeta">
          <span>Доступ: по ссылке</span>
          <span>Файл идёт напрямую в YouTube</span>
        </div>

        {busy && (
          <div className="uploadProgress" aria-label={`Загрузка ${progress}%`}>
            <span style={{ width: `${phase === "creating" ? 8 : progress}%` }} />
            <strong>{phase === "creating" ? "Готовлю YouTube..." : `${progress}%`}</strong>
          </div>
        )}

        {uploadError && <p className="uploadMessage error">{uploadError}</p>}
        {resultUrl && (
          <p className="uploadMessage success">
            Видео готово: <a href={resultUrl} target="_blank" rel="noreferrer">{resultUrl}</a>
          </p>
        )}

        <div className="uploadActions">
          <button type="button" className="uploadSecondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            Выбрать файл
          </button>
          <button type="submit" className="uploadPrimary" disabled={busy || !file || !title.trim()}>
            {phase === "uploading" ? "Загружаю..." : "Загрузить"}
          </button>
        </div>
      </form>
    </section>
  );
}

function AdminPanel({
  sessionToken,
  onChange,
}: {
  sessionToken: string;
  onChange: (next: AdminStudentsResponse) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);

  const createStudent = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
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

  const handleStudentKeyDown = (event: KeyboardEvent<HTMLElement>, student: StudentView) => {
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
        displayName: student.displayName,
        telegram: telegramDraftValue(student),
        ...current[student.id],
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
  const medal = showMedal ? podiumMedal(student.place) : null;
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
  onLeaderboard,
  onHomework,
  onProfile,
}: {
  activeScreen: ActiveScreen;
  onLeaderboard: () => void;
  onHomework: () => void;
  onProfile: () => void;
}) {
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
        className={`bottomNavButton bottomNavPrimary ${activeScreen === "homeworkUpload" ? "active" : ""}`}
        aria-label="Отправить ДЗ"
        aria-current={activeScreen === "homeworkUpload" ? "page" : undefined}
        onClick={onHomework}
      >
        <span className="navIcon navIconHomework" aria-hidden="true"><span className="uploadArrow" /><strong>ДЗ</strong></span>
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

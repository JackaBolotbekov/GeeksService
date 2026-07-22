"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AdminStudentsResponse, AuthResponse, HomeworkSubmitResponse, LeaderboardResponse, MeResponse, StudentView } from "@/lib/types";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type LoadState = "loading" | "ready" | "error";
type ActiveScreen = "leaderboard" | "homeworkUpload";
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

type ViewTransitionHandle = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function runWithViewTransition(update: () => void) {
  if (typeof document === "undefined" || prefersReducedMotion()) {
    update();
    return;
  }
  const documentWithTransition = document as Document & {
    startViewTransition?: (callback: () => void) => ViewTransitionHandle;
  };
  if (!documentWithTransition.startViewTransition) {
    update();
    return;
  }
  documentWithTransition.startViewTransition(() => {
    flushSync(update);
  });
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

function withScore(students: StudentView[], studentId: string, lessonNumber: number, score: number | null): StudentView[] {
  return rankVisibleStudents(students.map((student) => {
    if (student.id !== studentId) return student;
    const scores = student.scores.map((cell) => cell.lessonNumber === lessonNumber ? { ...cell, score } : cell);
    return {
      ...student,
      scores,
      completedLessons: scores.filter((cell) => cell.score !== null).length,
      totalScore: scores.reduce((sum, cell) => sum + (cell.score ?? 0), 0),
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

const GROUP_BADGES = ["VibeCoding-1", "6 урок >"] as const;

function RotatingGroupBadge() {
  const [badgeIndex, setBadgeIndex] = useState(0);
  const label = GROUP_BADGES[badgeIndex];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setBadgeIndex((current) => (current + 1) % GROUP_BADGES.length);
    }, 3200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="groupBadge" aria-label="Группа и текущий урок">
      <span key={label} className="groupBadgeText">{label}</span>
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
  const [leaderboard, setLeaderboard] = useState<StudentView[]>(initialStudents);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>("leaderboard");
  const leaderboardRef = useRef(leaderboard);

  useEffect(() => {
    leaderboardRef.current = leaderboard;
  }, [leaderboard]);

  const setLeaderboardSmooth = (next: StudentView[] | ((current: StudentView[]) => StudentView[])) => {
    runWithViewTransition(() => {
      setLeaderboard((current) => typeof next === "function" ? next(current) : next);
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
          <RotatingGroupBadge />
          {isAdmin && sessionToken && (
            <>
              <button
                type="button"
                className="editToggle"
                aria-label={bulkEditMode ? "Закрыть редактирование учеников" : "Редактировать учеников"}
                aria-pressed={bulkEditMode}
                onClick={() => {
                  hapticImpact("light");
                  runWithViewTransition(() => {
                    setBulkEditMode((current) => !current);
                    setShowAdminPanel(false);
                    setExpandedStudentId(null);
                  });
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
                  runWithViewTransition(() => {
                    setShowAdminPanel((current) => !current);
                    setBulkEditMode(false);
                    setExpandedStudentId(null);
                  });
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
          ) : (
            <>
              {isAdmin && sessionToken && showAdminPanel && (
                <AdminPanel
                  sessionToken={sessionToken}
                  onChange={applyAdminResponse}
                />
              )}
              <Leaderboard
                key={bulkEditMode ? "bulk-edit" : "score-view"}
                students={leaderboard}
                isAdmin={isAdmin && Boolean(sessionToken)}
                expandedStudentId={expandedStudentId}
                bulkEditMode={bulkEditMode}
                onBulkEditClose={() => {
                  runWithViewTransition(() => {
                    setBulkEditMode(false);
                  });
                }}
                onToggleStudent={toggleStudent}
                onScoreChange={async (student, lessonNumber, score) => {
                  if (!sessionToken) return;
                  const previous = leaderboardRef.current;
                  setLeaderboardSmooth((current) => withScore(current, student.id, lessonNumber, score));
                  try {
                    const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}/scores/${lessonNumber}`, {
                      method: "PUT",
                      body: JSON.stringify({ score }),
                    }, sessionToken);
                    applyAdminResponse(response);
                  } catch (caught) {
                    setLeaderboardSmooth(previous);
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
          />
        </>
      )}
    </main>
  );
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
  const [homeworkExtra, setHomeworkExtra] = useState("");
  const [homeworkDragActive, setHomeworkDragActive] = useState(false);
  const [homeworkPhase, setHomeworkPhase] = useState<HomeworkSubmitPhase>("idle");
  const [homeworkMessage, setHomeworkMessage] = useState<string | null>(null);
  const homeworkBusy = homeworkPhase === "submitting";
  const hasHomeworkContent = Boolean(homeworkLinks.trim() || homeworkDescription.trim() || homeworkExtra.trim() || homeworkFile);

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
    setHomeworkPhase("submitting");
    setHomeworkMessage(null);
    try {
      const form = new FormData();
      form.set("links", homeworkLinks.trim());
      form.set("description", homeworkDescription.trim());
      form.set("extra", homeworkExtra.trim());
      if (homeworkFile) form.set("file", homeworkFile);
      const result = await apiForm<HomeworkSubmitResponse>("/api/homework/submit", form, sessionToken);
      setHomeworkLinks("");
      setHomeworkDescription("");
      setHomeworkExtra("");
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
        <form className="uploadCard homeworkCard" onSubmit={(event) => {
          event.preventDefault();
          void submitHomework();
        }}>
          {!sessionToken && (
            <p className="uploadMessage error">
              Открой через Telegram, чтобы ДЗ привязалось к твоему профилю.
            </p>
          )}

          <label className="uploadField">
            <span>Ссылки</span>
            <input
              value={homeworkLinks}
              disabled={homeworkBusy}
              maxLength={5000}
              placeholder="GitHub, сайт, видео или другая ссылка"
              onChange={(event) => setHomeworkLinks(event.target.value)}
            />
          </label>

          <label className="uploadField">
            <span>Описание</span>
            <textarea
              value={homeworkDescription}
              disabled={homeworkBusy}
              maxLength={5000}
              placeholder="Что именно ты сдаёшь и что нужно проверить"
              onChange={(event) => setHomeworkDescription(event.target.value)}
            />
          </label>

          <label className="uploadField">
            <span>Дополнить от себя</span>
            <textarea
              className="compactTextarea"
              value={homeworkExtra}
              disabled={homeworkBusy}
              maxLength={5000}
              placeholder="Комменты, вопросы, что не получилось"
              onChange={(event) => setHomeworkExtra(event.target.value)}
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
              disabled={homeworkBusy}
              onChange={(event) => selectHomeworkFile(event.target.files?.item(0) ?? null)}
            />
            <span className="dropIcon">↑</span>
            <strong>{homeworkFile ? homeworkFile.name : "Файл домашки"}</strong>
            <small>{homeworkFile ? formatBytes(homeworkFile.size) : "нажми или перетащи markdown, pdf, zip, фото, видео"}</small>
          </label>

          {homeworkMessage && <p className={`uploadMessage ${homeworkPhase === "error" ? "error" : "success"}`}>{homeworkMessage}</p>}

          <div className="uploadActions">
            <button type="button" className="uploadSecondary" disabled={homeworkBusy} onClick={() => homeworkInputRef.current?.click()}>
              Выбрать файл
            </button>
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
            placeholder="Например: VibeCoding-1 · Урок 6"
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
    setSavingKey(key);
    setActiveLesson(null);
    hapticImpact("light");
    try {
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
                        disabled={Boolean(savingKey) || !isAdmin}
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
                        disabled={Boolean(savingKey)}
                        onClick={() => void saveScore(student, activeForStudent, score)}
                      >
                        {score}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="scoreClear"
                      disabled={Boolean(savingKey)}
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
}: {
  activeScreen: ActiveScreen;
  onLeaderboard: () => void;
  onHomework: () => void;
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
      <button type="button" className="bottomNavButton" aria-label="Профиль" onClick={() => hapticSelection()}>
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

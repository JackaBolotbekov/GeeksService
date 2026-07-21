"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AdminStudentsResponse, AuthResponse, LeaderboardResponse, MeResponse, StudentView } from "@/lib/types";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type LoadState = "loading" | "ready" | "error";

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

function useLockedViewportZoom() {
  useEffect(() => {
    const options: AddEventListenerOptions = { passive: false };
    const preventZoomGesture: EventListener = (event) => {
      event.preventDefault();
    };
    const preventMultiTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
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
    document.addEventListener("touchmove", preventMultiTouchZoom, options);
    document.addEventListener("touchend", preventDoubleTapZoom, options);
    document.addEventListener("dblclick", preventZoomGesture, options);

    return () => {
      document.removeEventListener("gesturestart", preventZoomGesture);
      document.removeEventListener("gesturechange", preventZoomGesture);
      document.removeEventListener("gestureend", preventZoomGesture);
      document.removeEventListener("touchmove", preventMultiTouchZoom);
      document.removeEventListener("touchend", preventDoubleTapZoom);
      document.removeEventListener("dblclick", preventZoomGesture);
    };
  }, []);
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
    runWithViewTransition(() => {
      setExpandedStudentId((current) => current === studentId ? null : studentId);
    });
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
    </main>
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
                    placeholder="Имя"
                    onChange={(event) => updateBulkDraft(student, "displayName", event.target.value)}
                  />
                  <input
                    className="bulkInput bulkTelegram"
                    value={bulkDraft.telegram}
                    disabled={bulkSaving}
                    placeholder="@username или TG ID"
                    inputMode={isTelegramId(bulkDraft.telegram) ? "numeric" : "text"}
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
              <Avatar student={student} />
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
                  {cell.score ?? "—"}
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
                          runWithViewTransition(() => {
                            setActiveLesson((current) =>
                              current?.studentId === student.id && current.lessonNumber === cell.lessonNumber
                                ? null
                                : { studentId: student.id, lessonNumber: cell.lessonNumber },
                            );
                          });
                        }}
                      >
                        <span>{cell.lessonNumber}</span>
                        <strong>{cell.score ?? "—"}</strong>
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

function Avatar({ student }: { student: StudentView }) {
  const [failed, setFailed] = useState(false);
  const initial = student.displayName
    .split(/\s+/)
    .filter(Boolean)
    .at(0)
    ?.at(0)
    ?.toUpperCase();

  if (shouldUseAvatar(student) && !failed) {
    return <img className="avatar" src={student.avatarUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className="avatar fallback">{initial || "G"}</span>;
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

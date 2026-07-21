"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
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

export function GeeksServiceApp({ initialStudents }: { initialStudents: StudentView[] }) {
  const [state, setState] = useState<LoadState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [leaderboard, setLeaderboard] = useState<StudentView[]>(initialStudents);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
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

  const expandStudent = (studentId: string) => {
    runWithViewTransition(() => {
      setExpandedStudentId(studentId);
    });
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
          {isAdmin && sessionToken && (
            <button
              type="button"
              className="addToggle"
              aria-label={showAdminPanel ? "Скрыть добавление ученика" : "Добавить ученика"}
              aria-expanded={showAdminPanel}
              onClick={() => {
                hapticImpact("light");
                runWithViewTransition(() => setShowAdminPanel((current) => !current));
              }}
            >
              +
            </button>
          )}
          <div className="status" aria-label="Online"><span /></div>
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
            students={leaderboard}
            isAdmin={isAdmin && Boolean(sessionToken)}
            expandedStudentId={expandedStudentId}
            onToggleStudent={toggleStudent}
            onExpandStudent={expandStudent}
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
            onNameChange={async (student, displayName) => {
              if (!sessionToken) return;
              const previous = leaderboardRef.current;
              setLeaderboardSmooth((current) => rankVisibleStudents(current.map((item) =>
                item.id === student.id ? { ...item, displayName } : item,
              )));
              try {
                const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ displayName }),
                }, sessionToken);
                applyAdminResponse(response);
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
  onToggleStudent,
  onExpandStudent,
  onScoreChange,
  onNameChange,
}: {
  students: StudentView[];
  isAdmin: boolean;
  expandedStudentId: string | null;
  onToggleStudent: (studentId: string) => void;
  onExpandStudent: (studentId: string) => void;
  onScoreChange: (student: StudentView, lessonNumber: number, score: number | null) => Promise<void>;
  onNameChange: (student: StudentView, displayName: string) => Promise<void>;
}) {
  const [activeLesson, setActiveLesson] = useState<{ studentId: string; lessonNumber: number } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const suppressNextClick = useRef(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingStudentId) return;
    const focusId = window.setTimeout(() => {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }, 30);
    return () => window.clearTimeout(focusId);
  }, [editingStudentId]);

  const clearLongPress = () => {
    if (longPressTimer.current === null) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const startLongPress = (event: PointerEvent<HTMLElement>, student: StudentView) => {
    if (!isAdmin) return;
    const target = event.target as HTMLElement;
    if (target.closest("button,input,select")) return;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      suppressNextClick.current = true;
      setEditingStudentId(student.id);
      setEditingName(student.displayName);
      setActiveLesson(null);
      hapticImpact("medium");
      onExpandStudent(student.id);
      window.setTimeout(() => {
        suppressNextClick.current = false;
      }, 800);
    }, 550);
  };

  const toggleStudentFromRow = (student: StudentView) => {
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
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

  const saveName = async (student: StudentView) => {
    const nextName = editingName.trim();
    if (!nextName || nextName === student.displayName) {
      setEditingStudentId(null);
      return;
    }
    setSavingName(true);
    try {
      await onNameChange(student, nextName);
      setEditingStudentId(null);
      hapticNotice("success");
    } catch {
      hapticNotice("error");
    } finally {
      setSavingName(false);
    }
  };

  if (students.length === 0) return <Panel text="Пока нет активных учеников" />;
  return (
    <section className="leaderboard">
      {students.map((student, index) => {
        const isExpanded = expandedStudentId === student.id;
        const activeForStudent = activeLesson?.studentId === student.id ? activeLesson.lessonNumber : null;
        const isSavingStudent = savingKey?.startsWith(`${student.id}:`) ?? false;
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
              onPointerDown={(event) => startLongPress(event, student)}
              onPointerUp={clearLongPress}
              onPointerLeave={clearLongPress}
              onPointerCancel={clearLongPress}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("button,input,select")) return;
                toggleStudentFromRow(student);
              }}
              onKeyDown={(event) => handleStudentKeyDown(event, student)}
              onContextMenu={(event) => {
                if (isAdmin) event.preventDefault();
              }}
            >
              <span className="place">{student.place}</span>
              <Avatar student={student} />
              <div className="studentInfo">
                {editingStudentId === student.id ? (
                  <input
                    ref={editInputRef}
                    className="inlineNameInput"
                    value={editingName}
                    disabled={savingName}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={() => void saveName(student)}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") setEditingStudentId(null);
                    }}
                    aria-label="Student name"
                  />
                ) : (
                  <strong>{student.displayName}</strong>
                )}
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

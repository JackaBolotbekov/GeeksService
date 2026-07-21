"use client";

/* eslint-disable @next/next/no-img-element */

import { PointerEvent, useEffect, useRef, useState } from "react";
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

export function GeeksServiceApp({ initialStudents }: { initialStudents: StudentView[] }) {
  const [state, setState] = useState<LoadState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [leaderboard, setLeaderboard] = useState<StudentView[]>(initialStudents);
  const [expandedStudentId, setExpandedStudentId] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const applyAdminResponse = (next: AdminStudentsResponse) => {
    setLeaderboard(next.students.filter((student) => student.status === "active"));
  };

  const refresh = async (token = sessionToken, admin = isAdmin) => {
    if (admin && token) {
      const response = await api<AdminStudentsResponse>("/api/admin/students", {}, token);
      setLeaderboard(response.students.filter((student) => student.status === "active"));
      return;
    }
    const response = await api<LeaderboardResponse>("/api/leaderboard");
    setLeaderboard(response.students);
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
          <span className="bolt">G</span>
          <span>GEEKS<span>Service</span></span>
        </div>
        <div className="topActions">
          {isAdmin && sessionToken && (
            <button
              type="button"
              className="addToggle"
              aria-label={showAdminPanel ? "Скрыть добавление ученика" : "Добавить ученика"}
              aria-expanded={showAdminPanel}
              onClick={() => setShowAdminPanel((current) => !current)}
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
            onToggleStudent={(studentId) => setExpandedStudentId((current) => current === studentId ? null : studentId)}
            onScoreChange={async (student, lessonNumber, score) => {
              if (!sessionToken) return;
              const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}/scores/${lessonNumber}`, {
                method: "PUT",
                body: JSON.stringify({ score }),
              }, sessionToken);
              applyAdminResponse(response);
            }}
            onNameChange={async (student, displayName) => {
              if (!sessionToken) return;
              const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}`, {
                method: "PATCH",
                body: JSON.stringify({ displayName }),
              }, sessionToken);
              applyAdminResponse(response);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin">
      <div className="sectionTitle">
        <span>Админ</span>
        <strong>добавить ученика</strong>
      </div>
      <div className="addRow">
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Имя ученика" />
        <input value={telegram} onChange={(event) => setTelegram(event.target.value)} placeholder="@username или Telegram ID" />
        <button type="button" disabled={busy} onClick={createStudent}>Добавить</button>
      </div>
    </section>
  );
}

function Leaderboard({
  students,
  isAdmin,
  expandedStudentId,
  onToggleStudent,
  onScoreChange,
  onNameChange,
}: {
  students: StudentView[];
  isAdmin: boolean;
  expandedStudentId: string | null;
  onToggleStudent: (studentId: string) => void;
  onScoreChange: (student: StudentView, lessonNumber: number, score: number | null) => Promise<void>;
  onNameChange: (student: StudentView, displayName: string) => Promise<void>;
}) {
  const [activeLesson, setActiveLesson] = useState<{ studentId: string; lessonNumber: number } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const longPressTimer = useRef<number | null>(null);
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
      setEditingStudentId(student.id);
      setEditingName(student.displayName);
      setActiveLesson(null);
      onToggleStudent(student.id);
    }, 550);
  };

  const saveScore = async (student: StudentView, lessonNumber: number, score: number | null) => {
    const key = `${student.id}:${lessonNumber}`;
    setSavingKey(key);
    try {
      await onScoreChange(student, lessonNumber, score);
      setActiveLesson(null);
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
    } finally {
      setSavingName(false);
    }
  };

  if (students.length === 0) return <Panel text="Пока нет активных учеников" />;
  return (
    <section className="leaderboard">
      {students.map((student) => {
        const isExpanded = expandedStudentId === student.id;
        const activeForStudent = activeLesson?.studentId === student.id ? activeLesson.lessonNumber : null;
        return (
          <article className={`student ${student.isCurrentUser ? "current" : ""} ${isExpanded ? "expanded" : ""}`} key={student.id}>
            <div
              className="studentMain"
              onPointerDown={(event) => startLongPress(event, student)}
              onPointerUp={clearLongPress}
              onPointerLeave={clearLongPress}
              onPointerCancel={clearLongPress}
              onContextMenu={(event) => {
                if (isAdmin) event.preventDefault();
              }}
            >
              <span className="place">{student.place}</span>
              <Avatar student={student} />
              <div className="studentInfo">
                <strong>{student.displayName}</strong>
                <span>{student.completedLessons}/12 домашек</span>
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
                {editingStudentId === student.id && (
                  <div className="nameEditor">
                    <input
                      ref={editInputRef}
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveName(student);
                        if (event.key === "Escape") setEditingStudentId(null);
                      }}
                      placeholder="Имя ученика"
                    />
                    <button type="button" disabled={savingName} onClick={() => saveName(student)}>
                      OK
                    </button>
                    <button type="button" disabled={savingName} onClick={() => setEditingStudentId(null)}>
                      ×
                    </button>
                  </div>
                )}
                <div className="lessonGrid">
                  {student.scores.map((cell) => {
                    const key = `${student.id}:${cell.lessonNumber}`;
                    return (
                      <button
                        type="button"
                        className={`lessonChip ${cell.score === null ? "" : "filled"} ${activeForStudent === cell.lessonNumber ? "active" : ""}`}
                        key={cell.lessonNumber}
                        disabled={savingKey === key || !isAdmin}
                        onClick={() => setActiveLesson((current) =>
                          current?.studentId === student.id && current.lessonNumber === cell.lessonNumber
                            ? null
                            : { studentId: student.id, lessonNumber: cell.lessonNumber },
                        )}
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
                        onClick={() => saveScore(student, activeForStudent, score)}
                      >
                        {score}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="scoreClear"
                      disabled={Boolean(savingKey)}
                      onClick={() => saveScore(student, activeForStudent, null)}
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
  const initials = student.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  if (shouldUseAvatar(student) && !failed) {
    return <img className="avatar" src={student.avatarUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className="avatar fallback">{initials || "G"}</span>;
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

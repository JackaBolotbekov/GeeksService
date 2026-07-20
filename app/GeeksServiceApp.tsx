"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import type { AdminStudentsResponse, AuthResponse, LeaderboardResponse, MeResponse, StudentView } from "@/lib/types";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

type LoadState = "loading" | "ready" | "error";

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

export function GeeksServiceApp() {
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [leaderboard, setLeaderboard] = useState<StudentView[]>([]);
  const [adminData, setAdminData] = useState<AdminStudentsResponse | null>(null);

  const refresh = async (token = sessionToken, admin = isAdmin) => {
    if (admin && token) {
      const response = await api<AdminStudentsResponse>("/api/admin/students", {}, token);
      setAdminData(response);
      setLeaderboard(response.students.filter((student) => student.status === "active"));
      return;
    }
    const response = await api<LeaderboardResponse>("/api/leaderboard");
    setLeaderboard(response.students);
  };

  useEffect(() => {
    const run = async () => {
      try {
        window.Telegram?.WebApp?.ready?.();
        window.Telegram?.WebApp?.expand?.();
        const initData = window.Telegram?.WebApp?.initData;
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

  const totalCompleted = useMemo(
    () => leaderboard.reduce((sum, student) => sum + student.completedLessons, 0),
    [leaderboard],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="bolt">G</span>
          <span>GEEKS<span>Service</span></span>
        </div>
        <div className="status"><span />ONLINE</div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">12 занятий · домашки · рейтинг</p>
          <h1>Leaderboard</h1>
        </div>
        <div className="heroStats">
          <strong>{leaderboard.length}</strong>
          <span>учеников</span>
          <strong>{totalCompleted}</strong>
          <span>домашек</span>
        </div>
      </section>

      {state === "loading" && <Panel text="Загружаю рейтинг..." />}
      {state === "error" && <Panel text={error ?? "Ошибка"} />}
      {isPending && <Panel text="Заявка отправлена. Админ скоро добавит тебя в активный список." />}

      {state === "ready" && (
        <>
          {isAdmin && sessionToken && (
            <AdminPanel
              data={adminData}
              sessionToken={sessionToken}
              onChange={async (next) => {
                setAdminData(next);
                setLeaderboard(next.students.filter((student) => student.status === "active"));
              }}
            />
          )}
          <Leaderboard students={leaderboard} />
        </>
      )}
    </main>
  );
}

function AdminPanel({
  data,
  sessionToken,
  onChange,
}: {
  data: AdminStudentsResponse | null;
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

  const setScore = async (student: StudentView, lessonNumber: number, score: number | null) => {
    const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}/scores/${lessonNumber}`, {
      method: "PUT",
      body: JSON.stringify({ score }),
    }, sessionToken);
    onChange(response);
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
      <div className="scoreList">
        {(data?.students ?? []).map((student) => (
          <article className="scoreCard" key={student.id}>
            <div className="scoreHead">
              <Avatar student={student} />
              <div>
                <strong>{student.displayName}</strong>
                <span>{student.completedLessons}/12 · {student.totalScore} баллов</span>
              </div>
            </div>
            <div className="scoreGrid">
              {student.scores.map((cell) => (
                <select
                  key={cell.lessonNumber}
                  aria-label={`Занятие ${cell.lessonNumber}`}
                  value={cell.score ?? ""}
                  onChange={(event) => setScore(student, cell.lessonNumber, event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">{cell.lessonNumber}</option>
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
                    <option key={score} value={score}>{score}</option>
                  ))}
                </select>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Leaderboard({ students }: { students: StudentView[] }) {
  if (students.length === 0) return <Panel text="Пока нет активных учеников" />;
  return (
    <section className="leaderboard">
      {students.map((student) => (
        <article className={`student ${student.isCurrentUser ? "current" : ""}`} key={student.id}>
          <span className="place">{student.place}</span>
          <Avatar student={student} />
          <div className="studentInfo">
            <strong>{student.displayName}</strong>
            <span>{student.completedLessons}/12 домашек · {student.totalScore} баллов</span>
          </div>
          <div className="delta">
            {student.pointsBehindLeader === 0 ? "TOP" : `-${student.pointsBehindLeader}`}
          </div>
        </article>
      ))}
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

  if (student.avatarUrl && !failed) {
    return <img className="avatar" src={student.avatarUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className="avatar fallback">{initials || "G"}</span>;
}

function Panel({ text }: { text: string }) {
  return <section className="panel">{text}</section>;
}

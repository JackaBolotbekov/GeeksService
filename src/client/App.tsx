import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { LESSON_COUNT, type AdminStudentsResponse, type AuthResponse, type LeaderboardResponse, type MeResponse, type StudentStatus, type StudentView } from "../shared/types";

interface AppConfig {
  telegramConfigured: boolean;
  devAuth: boolean;
}

interface ProfileState {
  displayName: string | null;
  avatarUrl: string | null;
  kind: "telegram" | "dev";
  isAdmin: boolean;
}

interface ScoreEditorState {
  student: StudentView;
  lessonNumber: number;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "Что-то пошло не так");
  return data as T;
}

function haptic(type: "success" | "error" | "light"): void {
  const feedback = window.Telegram?.WebApp.HapticFeedback;
  if (!feedback) return;
  if (type === "light") feedback.impactOccurred("light");
  else feedback.notificationOccurred(type);
}

export function App() {
  const [config, setConfig] = useState<AppConfig>({ telegramConfigured: false, devAuth: false });
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<StudentView[]>([]);
  const [adminData, setAdminData] = useState<AdminStudentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [editor, setEditor] = useState<ScoreEditorState | null>(null);

  const authHeaders = useMemo(() => (
    sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined
  ), [sessionToken]);

  const refresh = useCallback(async (token: string | null, currentProfile: ProfileState | null) => {
    const leaderboardResponse = await api<LeaderboardResponse>("/api/leaderboard", {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    setLeaderboard(leaderboardResponse.students);

    if (token) {
      const meResponse = await api<MeResponse>("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setMe(meResponse);
      if (currentProfile?.isAdmin || meResponse.isAdmin) {
        const adminResponse = await api<AdminStudentsResponse>("/api/admin/students", {
          headers: { Authorization: `Bearer ${token}` },
        });
        setAdminData(adminResponse);
      }
    }
  }, []);

  useEffect(() => {
    const telegram = window.Telegram?.WebApp;
    telegram?.ready();
    telegram?.expand();

    const initialize = async () => {
      try {
        const loadedConfig = await api<AppConfig>("/api/config");
        setConfig(loadedConfig);
        if (telegram?.initData) {
          const result = await api<AuthResponse>("/api/auth/telegram", {
            method: "POST",
            body: JSON.stringify({ initData: telegram.initData }),
          });
          setSessionToken(result.sessionToken);
          setProfile(result.profile);
          await refresh(result.sessionToken, result.profile);
        } else {
          await refresh(null, null);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Не удалось загрузить Geeks Service");
      } finally {
        setLoading(false);
      }
    };

    void initialize();
  }, [refresh]);

  const devLogin = async (admin: boolean) => {
    try {
      setLoading(true);
      const result = await api<AuthResponse>("/api/auth/dev", {
        method: "POST",
        body: JSON.stringify({
          displayName: admin ? "Админ Geeks" : "Тестовый ученик",
          telegramUserId: admin ? "1291298838" : "900000001",
          admin,
        }),
      });
      setSessionToken(result.sessionToken);
      setProfile(result.profile);
      await refresh(result.sessionToken, result.profile);
      haptic("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось войти");
      haptic("error");
    } finally {
      setLoading(false);
    }
  };

  const createStudent = async (displayName: string, telegramUserId: string) => {
    if (!authHeaders) return;
    try {
      const response = await api<AdminStudentsResponse>("/api/admin/students", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ displayName, telegramUserId: telegramUserId || null, status: "active" }),
      });
      setAdminData(response);
      await refresh(sessionToken, profile);
      haptic("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось добавить ученика");
      haptic("error");
    }
  };

  const patchStudent = async (student: StudentView, patch: { displayName?: string; status?: StudentStatus }) => {
    if (!authHeaders) return;
    try {
      const response = await api<AdminStudentsResponse>(`/api/admin/students/${student.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(patch),
      });
      setAdminData(response);
      await refresh(sessionToken, profile);
      haptic("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось обновить ученика");
      haptic("error");
    }
  };

  const setScore = async (score: number | null) => {
    if (!authHeaders || !editor) return;
    try {
      const response = await api<AdminStudentsResponse>(
        `/api/admin/students/${editor.student.id}/scores/${editor.lessonNumber}`,
        {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({ score }),
        },
      );
      setAdminData(response);
      setEditor(null);
      await refresh(sessionToken, profile);
      haptic("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось сохранить оценку");
      haptic("error");
    }
  };

  const currentStudent = me?.student ?? null;
  const isPending = Boolean(me?.pending);
  const isAdmin = Boolean(profile?.isAdmin || me?.isAdmin);

  return (
    <main className="app-shell">
      <Header profile={profile} />
      {loading ? (
        <LoadingScreen />
      ) : !sessionToken && !config.devAuth ? (
        <TelegramOnly configured={config.telegramConfigured} />
      ) : (
        <div className="page-grid">
          <section className="hero-panel">
            <span className="eyebrow">12 занятий · домашки · рейтинг</span>
            <h1>Geeks Service</h1>
            <p>Таблица учеников: кто сколько домашних заданий закрыл и сколько баллов набрал.</p>
            {config.devAuth && !sessionToken ? (
              <div className="dev-actions">
                <button onClick={() => void devLogin(false)}>Войти как ученик</button>
                <button onClick={() => void devLogin(true)}>Войти как админ</button>
              </div>
            ) : null}
          </section>

          {isPending ? <PendingCard student={currentStudent} /> : null}
          <Leaderboard students={leaderboard} currentStudentId={currentStudent?.id ?? null} />
          {isAdmin && adminData ? (
            <AdminPanel
              data={adminData}
              onCreate={createStudent}
              onPatch={patchStudent}
              onEditScore={(student, lessonNumber) => setEditor({ student, lessonNumber })}
            />
          ) : null}
        </div>
      )}

      <AnimatePresence>
        {editor ? (
          <ScoreEditor
            editor={editor}
            onClose={() => setEditor(null)}
            onSelect={(score) => void setScore(score)}
          />
        ) : null}
        {message ? <Toast message={message} onClose={() => setMessage(null)} /> : null}
      </AnimatePresence>
    </main>
  );
}

function Header({ profile }: { profile: ProfileState | null }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">G</span>
        <span>GEEKS<span>SERVICE</span></span>
      </div>
      <div className="profile-chip">
        <span className="online-dot" />
        {profile?.displayName ?? "leaderboard"}
      </div>
    </header>
  );
}

function LoadingScreen() {
  return (
    <section className="center-card">
      <span className="loader-dot" />
      <strong>Загружаем рейтинг</strong>
      <p>Проверяем Telegram и собираем баллы.</p>
    </section>
  );
}

function TelegramOnly({ configured }: { configured: boolean }) {
  return (
    <section className="center-card">
      <strong>Откройте через Telegram</strong>
      <p>{configured ? "Ученики входят через Mini App, чтобы видеть свой прогресс." : "BOT_TOKEN ещё не настроен на сервере."}</p>
    </section>
  );
}

function PendingCard({ student }: { student: StudentView | null }) {
  return (
    <motion.section className="pending-card" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
      <span>Заявка отправлена</span>
      <strong>{student?.displayName ?? "Ученик"}</strong>
      <p>Админ добавит вас в группу, после этого здесь появятся баллы и место в рейтинге.</p>
    </motion.section>
  );
}

function Leaderboard({ students, currentStudentId }: { students: StudentView[]; currentStudentId: string | null }) {
  const leader = students[0];
  return (
    <section className="leaderboard-panel">
      <div className="section-head">
        <span className="eyebrow">leaderboard</span>
        <h2>Рейтинг учеников</h2>
      </div>
      {students.length ? (
        <div className="student-list">
          {students.map((student) => (
            <StudentCard
              key={student.id}
              student={student}
              leaderScore={leader?.totalScore ?? 0}
              current={student.id === currentStudentId}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <strong>Пока нет активных учеников</strong>
          <p>Админ добавит 10 учеников, и рейтинг появится здесь.</p>
        </div>
      )}
    </section>
  );
}

function StudentCard({
  student,
  leaderScore,
  current,
}: {
  student: StudentView;
  leaderScore: number;
  current: boolean;
}) {
  const progress = Math.round((student.completedLessons / LESSON_COUNT) * 100);
  return (
    <motion.article layout className={`student-card ${current ? "is-current" : ""}`}>
      <div className="place">{student.place ?? "—"}</div>
      <Avatar student={student} />
      <div className="student-main">
        <strong>{student.displayName}</strong>
        <span>{student.completedLessons}/{LESSON_COUNT} домашек · {progress}%</span>
        <div className="progress-line"><i style={{ width: `${progress}%` }} /></div>
      </div>
      <div className="student-score">
        <strong>{student.totalScore}</strong>
        <span>{leaderScore === student.totalScore ? "лидер" : `до 1 места ${student.pointsBehindLeader}`}</span>
      </div>
    </motion.article>
  );
}

function Avatar({ student }: { student: StudentView }) {
  if (student.avatarUrl) return <img className="avatar" src={student.avatarUrl} alt="" />;
  const initials = student.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return <span className="avatar avatar-fallback">{initials || "G"}</span>;
}

function AdminPanel({
  data,
  onCreate,
  onPatch,
  onEditScore,
}: {
  data: AdminStudentsResponse;
  onCreate: (displayName: string, telegramUserId: string) => Promise<void>;
  onPatch: (student: StudentView, patch: { displayName?: string; status?: StudentStatus }) => Promise<void>;
  onEditScore: (student: StudentView, lessonNumber: number) => void;
}) {
  return (
    <section className="admin-panel">
      <div className="section-head">
        <span className="eyebrow">admin</span>
        <h2>Оценки и ученики</h2>
      </div>
      <CreateStudentForm onCreate={onCreate} />
      {data.pendingStudents.length ? (
        <div className="pending-list">
          <h3>Ожидают добавления</h3>
          {data.pendingStudents.map((student) => (
            <div className="pending-row" key={student.id}>
              <span>{student.displayName}</span>
              <button onClick={() => void onPatch(student, { status: "active" })}>Добавить</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="score-table">
        {data.students.map((student) => (
          <article className={`score-row ${student.status === "archived" ? "is-archived" : ""}`} key={student.id}>
            <div className="score-row-head">
              <strong>{student.displayName}</strong>
              <span>{student.totalScore} баллов · {student.completedLessons}/{LESSON_COUNT}</span>
              <button onClick={() => void onPatch(student, { status: student.status === "archived" ? "active" : "archived" })}>
                {student.status === "archived" ? "Вернуть" : "Архив"}
              </button>
            </div>
            <div className="lesson-grid">
              {student.scores.map((cell) => (
                <button
                  className={cell.score === null ? "" : "has-score"}
                  key={cell.lessonNumber}
                  onClick={() => onEditScore(student, cell.lessonNumber)}
                >
                  <span>{cell.lessonNumber}</span>
                  <strong>{cell.score ?? "—"}</strong>
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CreateStudentForm({ onCreate }: { onCreate: (displayName: string, telegramUserId: string) => Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [telegramUserId, setTelegramUserId] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate(displayName, telegramUserId);
    setDisplayName("");
    setTelegramUserId("");
  };

  return (
    <form className="create-form" onSubmit={(event) => void submit(event)}>
      <input
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder="Имя ученика"
        aria-label="Имя ученика"
      />
      <input
        value={telegramUserId}
        onChange={(event) => setTelegramUserId(event.target.value)}
        placeholder="Telegram ID, если есть"
        aria-label="Telegram ID"
      />
      <button disabled={displayName.trim().length < 2}>Добавить</button>
    </form>
  );
}

function ScoreEditor({
  editor,
  onClose,
  onSelect,
}: {
  editor: ScoreEditorState;
  onClose: () => void;
  onSelect: (score: number | null) => void;
}) {
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.section className="score-editor" initial={{ y: 28 }} animate={{ y: 0 }} exit={{ y: 28 }}>
        <button className="close-button" onClick={onClose} aria-label="Закрыть">×</button>
        <span className="eyebrow">занятие {editor.lessonNumber}</span>
        <h2>{editor.student.displayName}</h2>
        <div className="score-picker">
          {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
            <button key={score} onClick={() => onSelect(score)}>{score}</button>
          ))}
        </div>
        <button className="clear-score" onClick={() => onSelect(null)}>Очистить оценку</button>
      </motion.section>
    </motion.div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timer);
  }, [onClose]);

  return (
    <motion.div className="toast" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 18 }}>
      {message}
    </motion.div>
  );
}

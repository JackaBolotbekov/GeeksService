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

  const authHeaders = useMemo(() => (
    sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined
  ), [sessionToken]);

  const refresh = useCallback(async (token: string | null, currentProfile: ProfileState | null) => {
    const leaderboardResponse = await api<LeaderboardResponse>("/api/leaderboard", {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    setLeaderboard(leaderboardResponse.students);

    if (!token) return;

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

  const createStudent = async (displayName: string, telegram: string) => {
    if (!authHeaders) return;
    try {
      const response = await api<AdminStudentsResponse>("/api/admin/students", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ displayName, telegram: telegram || null, status: "active" }),
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
        <div className="page-stack">
          {config.devAuth && !sessionToken ? (
            <section className="dev-card">
              <button onClick={() => void devLogin(true)}>Войти как админ</button>
              <button onClick={() => void devLogin(false)}>Войти как ученик</button>
            </section>
          ) : null}

          {isAdmin && adminData ? (
            <AdminPanel
              data={adminData}
              onCreate={createStudent}
              onPatch={patchStudent}
            />
          ) : null}

          {isPending ? <PendingCard student={currentStudent} /> : null}

          <Leaderboard students={leaderboard} currentStudentId={currentStudent?.id ?? null} />
        </div>
      )}

      <AnimatePresence>
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
        <span>{profile?.displayName ?? "online"}</span>
      </div>
    </header>
  );
}

function LoadingScreen() {
  return (
    <section className="center-card">
      <span className="loader-dot" />
      <strong>Загружаем</strong>
    </section>
  );
}

function TelegramOnly({ configured }: { configured: boolean }) {
  return (
    <section className="center-card">
      <strong>Откройте через Telegram</strong>
      <p>{configured ? "Ученики входят через Mini App." : "BOT_TOKEN ещё не настроен на сервере."}</p>
    </section>
  );
}

function PendingCard({ student }: { student: StudentView | null }) {
  return (
    <section className="pending-card">
      <span>Заявка отправлена</span>
      <strong>{student?.displayName ?? "Ученик"}</strong>
      <p>Админ подтвердит вас, и вы появитесь в рейтинге.</p>
    </section>
  );
}

function AdminPanel({
  data,
  onCreate,
  onPatch,
}: {
  data: AdminStudentsResponse;
  onCreate: (displayName: string, telegram: string) => Promise<void>;
  onPatch: (student: StudentView, patch: { displayName?: string; status?: StudentStatus }) => Promise<void>;
}) {
  const activeStudents = data.students.filter((student) => student.status === "active");
  const archivedStudents = data.students.filter((student) => student.status === "archived");

  return (
    <section className="admin-panel">
      <div className="section-head">
        <div>
          <span className="eyebrow">admin</span>
          <h1>Ученики</h1>
        </div>
        <span className="counter">{activeStudents.length}</span>
      </div>

      <CreateStudentForm onCreate={onCreate} />

      {data.pendingStudents.length ? (
        <div className="compact-block">
          <h2>Заявки</h2>
          {data.pendingStudents.map((student) => (
            <StudentRow
              key={student.id}
              student={student}
              actionLabel="Добавить"
              onAction={() => void onPatch(student, { status: "active" })}
            />
          ))}
        </div>
      ) : null}

      <div className="compact-block">
        <h2>Список</h2>
        {activeStudents.length ? (
          activeStudents.map((student) => (
            <StudentRow
              key={student.id}
              student={student}
              actionLabel="Архив"
              mutedAction
              onAction={() => void onPatch(student, { status: "archived" })}
            />
          ))
        ) : (
          <p className="muted">Пока пусто. Добавьте ученика по имени, @username или Telegram ID.</p>
        )}
      </div>

      {archivedStudents.length ? (
        <details className="archive-details">
          <summary>Архив: {archivedStudents.length}</summary>
          {archivedStudents.map((student) => (
            <StudentRow
              key={student.id}
              student={student}
              actionLabel="Вернуть"
              onAction={() => void onPatch(student, { status: "active" })}
            />
          ))}
        </details>
      ) : null}
    </section>
  );
}

function CreateStudentForm({ onCreate }: { onCreate: (displayName: string, telegram: string) => Promise<void> }) {
  const [displayName, setDisplayName] = useState("");
  const [telegram, setTelegram] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate(displayName.trim(), telegram.trim());
    setDisplayName("");
    setTelegram("");
  };

  return (
    <form className="create-form" onSubmit={(event) => void submit(event)}>
      <input
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder="Имя ученика"
        aria-label="Имя ученика"
        autoComplete="off"
      />
      <input
        value={telegram}
        onChange={(event) => setTelegram(event.target.value)}
        placeholder="@username или Telegram ID"
        aria-label="Telegram username или ID"
        autoComplete="off"
      />
      <button disabled={displayName.trim().length < 2}>Добавить</button>
      <p>Контакты Telegram Mini App не читает. Надёжный способ: добавьте по @username или попросите ученика открыть Mini App - он появится в заявках.</p>
    </form>
  );
}

function StudentRow({
  student,
  actionLabel,
  mutedAction,
  onAction,
}: {
  student: StudentView;
  actionLabel: string;
  mutedAction?: boolean;
  onAction: () => void;
}) {
  return (
    <article className="student-row">
      <Avatar student={student} />
      <div>
        <strong>{student.displayName}</strong>
        <span>{student.telegramUsername ? `@${student.telegramUsername}` : student.telegramUserId ? `ID ${student.telegramUserId}` : "без привязки"}</span>
      </div>
      <button className={mutedAction ? "muted-button" : ""} onClick={onAction}>{actionLabel}</button>
    </article>
  );
}

function Leaderboard({ students, currentStudentId }: { students: StudentView[]; currentStudentId: string | null }) {
  const leader = students[0];
  return (
    <section className="leaderboard-panel">
      <div className="section-head">
        <div>
          <span className="eyebrow">leaderboard</span>
          <h1>Рейтинг</h1>
        </div>
        <span className="counter">{students.length}</span>
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
        <p className="muted empty">Пока нет активных учеников.</p>
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
  return (
    <motion.article layout className={`student-card ${current ? "is-current" : ""}`}>
      <div className="place">{student.place ?? "-"}</div>
      <Avatar student={student} />
      <div className="student-main">
        <strong>{student.displayName}</strong>
        <span>{student.completedLessons}/{LESSON_COUNT} домашек</span>
      </div>
      <div className="student-score">
        <strong>{student.totalScore}</strong>
        <span>{leaderScore === student.totalScore ? "лидер" : `-${student.pointsBehindLeader}`}</span>
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

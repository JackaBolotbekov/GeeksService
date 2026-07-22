import { LESSON_COUNT, type LessonScheduleInput, type LessonScheduleItem, type ScheduleMonth, type ScheduleResponse } from "./types";

export const BISHKEK_TIME_ZONE = "Asia/Bishkek";

export const DEFAULT_LESSON_SCHEDULE: LessonScheduleInput[] = [
  { lessonNumber: 1, scheduledAt: "2026-07-06T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 2, scheduledAt: "2026-07-08T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 3, scheduledAt: "2026-07-10T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 4, scheduledAt: "2026-07-13T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 5, scheduledAt: "2026-07-15T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 6, scheduledAt: "2026-07-20T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 7, scheduledAt: "2026-07-22T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 8, scheduledAt: "2026-07-24T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 9, scheduledAt: "2026-07-27T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 10, scheduledAt: "2026-07-29T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 11, scheduledAt: "2026-07-31T16:00:00+06:00", courseMonth: 1 },
  { lessonNumber: 12, scheduledAt: "2026-08-03T16:00:00+06:00", courseMonth: 1 },
];

const MONTH_LABELS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

type ScheduleSource = LessonScheduleInput & {
  updatedAt?: string | null;
};

export function buildScheduleResponse(source: ScheduleSource[], now = new Date()): ScheduleResponse {
  const lessons = normalizeLessonSchedule(source).map((lesson) => ({
    ...lesson,
    updatedAt: lesson.updatedAt ?? null,
    isCompleted: new Date(lesson.scheduledAt).getTime() <= now.getTime(),
  }));
  const completed = lessons.filter((lesson) => lesson.isCompleted);
  const currentCourseMonth = completed.at(-1)?.courseMonth ?? lessons[0]?.courseMonth ?? 1;
  return {
    lessons,
    months: scheduleMonths(lessons),
    currentLabel: `${currentCourseMonth} мес ${completed.length} урок`,
    completedLessonCount: completed.length,
    currentCourseMonth,
  };
}

export function normalizeLessonSchedule(source: ScheduleSource[]): Array<ScheduleSource & { courseMonth: number }> {
  if (!Array.isArray(source) || source.length !== LESSON_COUNT) {
    throw new Error(`Нужно ровно ${LESSON_COUNT} уроков в расписании`);
  }
  const seen = new Set<number>();
  const normalized = source.map((item) => {
    const lessonNumber = Number(item.lessonNumber);
    if (!Number.isInteger(lessonNumber) || lessonNumber < 1 || lessonNumber > LESSON_COUNT) {
      throw new Error(`Номер урока должен быть от 1 до ${LESSON_COUNT}`);
    }
    if (seen.has(lessonNumber)) throw new Error(`Урок ${lessonNumber} указан дважды`);
    seen.add(lessonNumber);
    const scheduledAt = String(item.scheduledAt ?? "").trim();
    if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
      throw new Error(`Дата урока ${lessonNumber} указана неверно`);
    }
    const courseMonth = Number(item.courseMonth ?? 1);
    if (!Number.isInteger(courseMonth) || courseMonth < 1 || courseMonth > 12) {
      throw new Error("Месяц курса должен быть от 1 до 12");
    }
    return {
      ...item,
      lessonNumber,
      scheduledAt,
      courseMonth,
    };
  });
  return normalized.sort((left, right) => left.lessonNumber - right.lessonNumber);
}

export function scheduleMonths(lessons: Pick<LessonScheduleItem, "scheduledAt">[]): ScheduleMonth[] {
  const byKey = new Map<string, ScheduleMonth>();
  for (const lesson of lessons) {
    const parts = localDateParts(lesson.scheduledAt);
    const key = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        year: parts.year,
        month: parts.month,
        label: `${MONTH_LABELS[parts.month - 1]} ${parts.year}`,
      });
    }
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function localDateParts(iso: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new Error("Дата должна быть ISO-строкой");
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function bishkekDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BISHKEK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

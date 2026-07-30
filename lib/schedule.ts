import { LESSON_COUNT, type LessonScheduleInput, type LessonScheduleItem, type LessonScheduleTransfer, type ScheduleMonth, type ScheduleResponse } from "./types";

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

export class ScheduleConflictError extends Error {}

export function buildScheduleResponse(
  source: ScheduleSource[],
  now = new Date(),
  transfers: LessonScheduleTransfer[] = [],
): ScheduleResponse {
  const lessons = normalizeLessonSchedule(source).map((lesson) => ({
    ...lesson,
    updatedAt: lesson.updatedAt ?? null,
    isCompleted: new Date(lesson.scheduledAt).getTime() <= now.getTime(),
  }));
  const completed = lessons.filter((lesson) => lesson.isCompleted);
  const currentCourseMonth = completed.at(-1)?.courseMonth ?? lessons[0]?.courseMonth ?? 1;
  const latestTransfer = transfers.at(-1) ?? null;
  return {
    lessons,
    transfers,
    cancellableTransferId: latestTransfer
      && new Date(latestTransfer.originalScheduledAt).getTime() > now.getTime()
      && new Date(latestTransfer.rescheduledAt).getTime() > now.getTime()
      ? latestTransfer.id
      : null,
    months: scheduleMonths([
      ...lessons,
      ...transfers.map((transfer) => ({ scheduledAt: transfer.originalScheduledAt })),
    ]),
    currentLabel: `${currentCourseMonth} мес ${completed.length} урок`,
    completedLessonCount: completed.length,
    currentCourseMonth,
  };
}

export function transferLessonSchedule(
  source: ScheduleSource[],
  lessonNumber: number,
  expectedScheduledAt: string,
  targetScheduledAt = defaultTransferTarget(expectedScheduledAt),
  now = new Date(),
): { lessons: LessonScheduleInput[]; transfer: LessonScheduleTransfer } {
  const lessons = normalizeLessonSchedule(source);
  const selectedIndex = lessons.findIndex((lesson) => lesson.lessonNumber === lessonNumber);
  if (selectedIndex < 0) throw new Error("Занятие не найдено");
  const selected = lessons[selectedIndex];
  if (selected.scheduledAt !== expectedScheduledAt) {
    throw new ScheduleConflictError("Расписание уже изменилось. Обнови календарь и попробуй снова");
  }
  if (new Date(selected.scheduledAt).getTime() <= now.getTime()) {
    throw new Error("Начавшееся занятие переносить нельзя");
  }
  if (!targetScheduledAt || Number.isNaN(new Date(targetScheduledAt).getTime())) {
    throw new Error("Укажи корректные дату и время переноса");
  }
  if (new Date(targetScheduledAt).getTime() <= Math.max(now.getTime(), new Date(selected.scheduledAt).getTime())) {
    throw new Error("Новая дата должна быть позже текущего времени занятия");
  }
  const previous = lessons[selectedIndex - 1];
  if (previous && new Date(targetScheduledAt).getTime() <= new Date(previous.scheduledAt).getTime()) {
    throw new Error("Новая дата должна быть позже предыдущего занятия");
  }

  const shifted = lessons.map((lesson) => ({
    lessonNumber: lesson.lessonNumber,
    scheduledAt: lesson.scheduledAt,
    courseMonth: lesson.courseMonth,
  }));
  shifted[selectedIndex].scheduledAt = targetScheduledAt;
  for (let index = selectedIndex + 1; index < shifted.length; index += 1) {
    shifted[index].scheduledAt = nextTeachingSlot(
      shifted[index - 1].scheduledAt,
      timeSuffix(lessons[index].scheduledAt),
    );
  }

  return {
    lessons: shifted,
    transfer: {
      id: `preview-${lessonNumber}-${now.getTime()}`,
      lessonNumber: selected.lessonNumber,
      originalScheduledAt: selected.scheduledAt,
      rescheduledAt: shifted[selectedIndex].scheduledAt,
      reason: null,
      createdAt: now.toISOString(),
    },
  };
}

export function defaultTransferTarget(iso: string): string {
  return nextTeachingSlot(iso, timeSuffix(iso));
}

export function restoreLessonTransferSchedule(
  source: ScheduleSource[],
  lessonNumber: number,
  originalScheduledAt: string,
): LessonScheduleInput[] {
  const lessons = normalizeLessonSchedule(source);
  const selectedIndex = lessons.findIndex((lesson) => lesson.lessonNumber === lessonNumber);
  if (selectedIndex < 0) throw new Error("Занятие не найдено");
  if (!originalScheduledAt || Number.isNaN(new Date(originalScheduledAt).getTime())) {
    throw new Error("Исходная дата занятия указана неверно");
  }
  const previous = lessons[selectedIndex - 1];
  if (previous && new Date(originalScheduledAt).getTime() <= new Date(previous.scheduledAt).getTime()) {
    throw new ScheduleConflictError("Исходная дата конфликтует с предыдущим занятием");
  }

  const restored = lessons.map((lesson) => ({
    lessonNumber: lesson.lessonNumber,
    scheduledAt: lesson.scheduledAt,
    courseMonth: lesson.courseMonth,
  }));
  restored[selectedIndex].scheduledAt = originalScheduledAt;
  for (let index = selectedIndex + 1; index < restored.length; index += 1) {
    restored[index].scheduledAt = nextTeachingSlot(
      restored[index - 1].scheduledAt,
      timeSuffix(lessons[index].scheduledAt),
    );
  }
  return restored;
}

function timeSuffix(iso: string): string {
  const match = /^\d{4}-\d{2}-\d{2}(T.*)$/.exec(iso);
  if (!match) throw new Error("Дата занятия должна быть ISO-строкой");
  return match[1];
}

function nextTeachingSlot(iso: string, suffix = timeSuffix(iso)): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(T.*)$/.exec(iso);
  if (!match) throw new Error("Дата занятия должна быть ISO-строкой");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (![1, 3, 5].includes(date.getUTCDay()));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}${suffix}`;
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

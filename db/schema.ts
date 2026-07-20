import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  telegramUserId: text("telegram_user_id"),
  telegramUsername: text("telegram_username"),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at"),
}, (table) => ({
  telegramUserIdIdx: uniqueIndex("students_telegram_user_id_unique").on(table.telegramUserId),
  telegramUsernameIdx: uniqueIndex("students_telegram_username_unique").on(table.telegramUsername),
}));

export const lessonScores = sqliteTable("lesson_scores", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  lessonNumber: integer("lesson_number").notNull(),
  score: integer("score"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  studentLessonIdx: uniqueIndex("lesson_scores_student_lesson_unique").on(table.studentId, table.lessonNumber),
}));

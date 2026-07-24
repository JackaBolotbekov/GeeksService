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

export const homeworkSubmissions = sqliteTable("homework_submissions", {
  id: text("id").primaryKey(),
  studentId: text("student_id").references(() => students.id, { onDelete: "set null" }),
  telegramUserId: text("telegram_user_id").notNull(),
  studentName: text("student_name").notNull(),
  links: text("links").notNull().default(""),
  description: text("description").notNull().default(""),
  extra: text("extra").notNull().default(""),
  fileKey: text("file_key"),
  fileName: text("file_name"),
  fileType: text("file_type"),
  fileSize: integer("file_size"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const teacherMaterials = sqliteTable("teacher_materials", {
  id: text("id").primaryKey(),
  lessonNumber: integer("lesson_number").notNull(),
  courseMonth: integer("course_month").notNull().default(1),
  videoId: text("video_id"),
  videoUrl: text("video_url"),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  fileKeyIdx: uniqueIndex("teacher_materials_file_key_unique").on(table.fileKey),
}));

export const teacherUploadJobs = sqliteTable("teacher_upload_jobs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(),
  lessonNumber: integer("lesson_number").notNull().default(1),
  courseMonth: integer("course_month").notNull().default(1),
  uploadUrl: text("upload_url"),
  progress: integer("progress").notNull().default(0),
  phase: text("phase").notNull().default("creating"),
  videoId: text("video_id"),
  videoUrl: text("video_url"),
  errorMessage: text("error_message"),
  uploaderTelegramId: text("uploader_telegram_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const teacherLessonVideos = sqliteTable("teacher_lesson_videos", {
  id: text("id").primaryKey(),
  lessonNumber: integer("lesson_number").notNull(),
  courseMonth: integer("course_month").notNull().default(1),
  videoId: text("video_id").notNull(),
  videoUrl: text("video_url").notNull(),
  title: text("title").notNull(),
  verifiedAt: text("verified_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  lessonIdx: uniqueIndex("teacher_lesson_videos_lesson_unique").on(table.courseMonth, table.lessonNumber),
  videoIdx: uniqueIndex("teacher_lesson_videos_video_id_unique").on(table.videoId),
}));

export const lessonSchedule = sqliteTable("lesson_schedule", {
  id: text("id").primaryKey(),
  lessonNumber: integer("lesson_number").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  courseMonth: integer("course_month").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  lessonNumberIdx: uniqueIndex("lesson_schedule_lesson_number_unique").on(table.lessonNumber),
}));

export const lessonScheduleTransfers = sqliteTable("lesson_schedule_transfers", {
  id: text("id").primaryKey(),
  lessonNumber: integer("lesson_number").notNull(),
  originalScheduledAt: text("original_scheduled_at").notNull(),
  rescheduledAt: text("rescheduled_at").notNull(),
  beforeScheduleJson: text("before_schedule_json"),
  cancelledAt: text("cancelled_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  originalLessonIdx: uniqueIndex("lesson_schedule_transfers_original_unique").on(
    table.lessonNumber,
    table.originalScheduledAt,
  ),
}));

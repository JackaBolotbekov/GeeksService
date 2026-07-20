-- CreateTable
CREATE TABLE "students" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "telegram_user_id" BIGINT,
  "display_name" TEXT NOT NULL,
  "avatar_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "last_seen_at" DATETIME
);

-- CreateTable
CREATE TABLE "lesson_scores" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "student_id" TEXT NOT NULL,
  "lesson_number" INTEGER NOT NULL,
  "score" INTEGER,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "lesson_scores_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "students_telegram_user_id_key" ON "students"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_scores_student_id_lesson_number_key" ON "lesson_scores"("student_id", "lesson_number");

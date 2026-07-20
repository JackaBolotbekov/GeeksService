-- Add optional Telegram username binding for students added before they open the Mini App.
ALTER TABLE "students" ADD COLUMN "telegram_username" TEXT;

CREATE UNIQUE INDEX "students_telegram_username_key" ON "students"("telegram_username");

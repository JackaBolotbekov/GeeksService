CREATE TABLE `lesson_schedule` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_number` integer NOT NULL,
	`scheduled_at` text NOT NULL,
	`course_month` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_schedule_lesson_number_unique` ON `lesson_schedule` (`lesson_number`);
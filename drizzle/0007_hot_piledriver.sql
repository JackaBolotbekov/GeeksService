CREATE TABLE `teacher_lesson_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_number` integer NOT NULL,
	`course_month` integer DEFAULT 1 NOT NULL,
	`video_id` text NOT NULL,
	`video_url` text NOT NULL,
	`title` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_lesson_videos_lesson_unique` ON `teacher_lesson_videos` (`course_month`,`lesson_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_lesson_videos_video_id_unique` ON `teacher_lesson_videos` (`video_id`);--> statement-breakpoint
ALTER TABLE `teacher_upload_jobs` ADD `lesson_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `teacher_upload_jobs` ADD `course_month` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `teacher_upload_jobs` ADD `upload_url` text;
CREATE TABLE `teacher_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_number` integer NOT NULL,
	`course_month` integer DEFAULT 1 NOT NULL,
	`video_id` text,
	`video_url` text,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_materials_file_key_unique` ON `teacher_materials` (`file_key`);
CREATE TABLE `teacher_material_upload_parts` (
	`session_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	`part_size` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `teacher_material_upload_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_material_upload_parts_session_part_unique` ON `teacher_material_upload_parts` (`session_id`,`part_number`);--> statement-breakpoint
CREATE TABLE `teacher_material_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`part_size` integer NOT NULL,
	`lesson_number` integer NOT NULL,
	`course_month` integer DEFAULT 1 NOT NULL,
	`video_id` text,
	`video_url` text,
	`uploader_telegram_id` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`material_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_material_upload_sessions_file_key_unique` ON `teacher_material_upload_sessions` (`file_key`);--> statement-breakpoint
CREATE INDEX `teacher_material_upload_sessions_lookup_idx` ON `teacher_material_upload_sessions` (`uploader_telegram_id`,`course_month`,`lesson_number`,`file_name`,`file_size`,`created_at`);
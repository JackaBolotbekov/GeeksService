CREATE TABLE `teacher_upload_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'creating' NOT NULL,
	`video_id` text,
	`video_url` text,
	`error_message` text,
	`uploader_telegram_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

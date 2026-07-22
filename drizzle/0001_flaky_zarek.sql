CREATE TABLE `homework_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text,
	`telegram_user_id` text NOT NULL,
	`student_name` text NOT NULL,
	`links` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`extra` text DEFAULT '' NOT NULL,
	`file_key` text,
	`file_name` text,
	`file_type` text,
	`file_size` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE set null
);

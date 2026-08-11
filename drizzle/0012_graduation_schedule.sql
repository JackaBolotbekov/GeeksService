CREATE TABLE `course_schedule_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`graduation_at` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `course_schedule_settings` (`id`, `graduation_at`)
VALUES ('graduation', '2026-08-14T16:00:00+06:00');

CREATE TABLE `teacher_upload_chunk_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`confirmed_offset` integer NOT NULL,
	`chunk_size` integer NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`speed_bps` integer NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`http_status` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `teacher_upload_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `teacher_upload_chunk_events_job_created_idx` ON `teacher_upload_chunk_events` (`job_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `teacher_upload_jobs` ADD `confirmed_offset` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `teacher_upload_jobs` ADD `chunk_size` integer;
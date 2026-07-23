CREATE TABLE `lesson_schedule_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_number` integer NOT NULL,
	`original_scheduled_at` text NOT NULL,
	`rescheduled_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_schedule_transfers_original_unique` ON `lesson_schedule_transfers` (`lesson_number`,`original_scheduled_at`);
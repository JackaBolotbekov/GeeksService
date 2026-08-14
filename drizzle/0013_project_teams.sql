CREATE TABLE `project_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`place` integer CHECK (`place` IS NULL OR `place` BETWEEN 1 AND 3),
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_teams_name_key_unique` ON `project_teams` (`name_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_teams_place_unique` ON `project_teams` (`place`) WHERE `place` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `project_team_members` (
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`team_id`, `student_id`),
	FOREIGN KEY (`team_id`) REFERENCES `project_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_team_members_student_unique` ON `project_team_members` (`student_id`);
--> statement-breakpoint
CREATE INDEX `project_team_members_team_order_idx` ON `project_team_members` (`team_id`,`sort_order`);
--> statement-breakpoint
PRAGMA optimize;

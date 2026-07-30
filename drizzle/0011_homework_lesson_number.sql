ALTER TABLE `homework_submissions` ADD `lesson_number` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `homework_submissions_student_lesson_unique`
ON `homework_submissions` (`student_id`, `lesson_number`)
WHERE `student_id` IS NOT NULL AND `lesson_number` IS NOT NULL;

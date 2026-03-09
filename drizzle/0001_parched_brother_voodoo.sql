ALTER TABLE `messages` ADD `processed_at` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `processing_lock_at` text;
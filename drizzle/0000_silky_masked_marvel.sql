CREATE TABLE `commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command` text NOT NULL,
	`text` text NOT NULL,
	`embedding` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_commands_command` ON `commands` (`command`);--> statement-breakpoint
CREATE INDEX `idx_commands_created_at` ON `commands` (`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_participants` (
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`title` text,
	`avatar_url` text,
	`created_by_user_id` text,
	`is_group` integer DEFAULT false,
	`is_muted` integer DEFAULT false,
	`last_processed_message_id` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`attachment_type` text,
	`url` text,
	`preview_url` text,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_media_message` ON `media` (`message_id`);--> statement-breakpoint
CREATE TABLE `message_features` (
	`message_id` text PRIMARY KEY NOT NULL,
	`is_question` integer DEFAULT false,
	`sentiment_score` integer,
	`emotion` text,
	`length` integer,
	`emoji_count` integer,
	`mention_count` integer,
	`has_url` integer,
	`language` text,
	`topic_hint` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_features_question` ON `message_features` (`is_question`);--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reaction` text NOT NULL,
	`timestamp_ms` integer,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`message_type` text,
	`text_content` text,
	`reply_to_message_id` text,
	`is_edited` integer DEFAULT false,
	`is_deleted` integer DEFAULT false,
	`raw_payload` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_message_id_unique` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_time` ON `messages` (`conversation_id`,`timestamp_ms`);--> statement-breakpoint
CREATE INDEX `idx_messages_user` ON `messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_reply` ON `messages` (`reply_to_message_id`);--> statement-breakpoint
CREATE TABLE `outgoing` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`router_decision_id` integer,
	`conversation_id` text NOT NULL,
	`target_message_id` text,
	`target_user_id` text,
	`action_type` text NOT NULL,
	`effort_level` text,
	`intent_label` text,
	`message_content` text,
	`execution_status` text,
	`platform_message_id` text,
	`execution_error` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_outgoing_conv` ON `outgoing` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`platform_user_id` text,
	`username` text,
	`display_name` text,
	`avatar_url` text,
	`is_verified` integer DEFAULT false,
	`platform` text,
	`created_at` text DEFAULT (datetime('now'))
);

CREATE TABLE `chat_participants` (
	`chat_id` text NOT NULL,
	`sender_fbid` text NOT NULL,
	PRIMARY KEY(`chat_id`, `sender_fbid`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`chat_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_fbid`) REFERENCES `users`(`sender_fbid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`image_url` text,
	`group_creator_id` text,
	`is_group` integer DEFAULT false,
	`is_muted` integer DEFAULT false,
	`last_processed_mid` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_mid` text NOT NULL,
	`media_type` text,
	`url` text,
	`preview_url` text,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`message_mid`) REFERENCES `messages`(`mid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_media_message` ON `media` (`message_mid`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mid` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_fbid` text NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`content_type` text,
	`text_body` text,
	`replied_to_mid` text,
	`edited` integer DEFAULT false,
	`deleted` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`chat_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_mid_unique` ON `messages` (`mid`);--> statement-breakpoint
CREATE INDEX `idx_messages_chat_time` ON `messages` (`chat_id`,`timestamp_ms`);--> statement-breakpoint
CREATE INDEX `idx_messages_sender` ON `messages` (`sender_fbid`);--> statement-breakpoint
CREATE TABLE `outgoing_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`target_message_mid` text,
	`type` text NOT NULL,
	`effort` text,
	`title` text,
	`content` text,
	`reason` text,
	`platform_mid` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_mid` text NOT NULL,
	`sender_fbid` text NOT NULL,
	`reaction` text NOT NULL,
	`timestamp_ms` integer,
	FOREIGN KEY (`message_mid`) REFERENCES `messages`(`mid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`sender_fbid` text PRIMARY KEY NOT NULL,
	`username` text,
	`full_name` text,
	`profile_pic_url` text,
	`is_verified` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now'))
);

CREATE TABLE `api_presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`report` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`idx` integer NOT NULL,
	`kind` text NOT NULL,
	`seat` integer NOT NULL,
	`decision` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_game_idx` ON `game_decisions` (`game_id`,`idx`);--> statement-breakpoint
CREATE TABLE `game_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`seq` integer NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`type` text NOT NULL,
	`actor` integer,
	`actor_label` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`thought` text,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_game_seq` ON `game_events` (`game_id`,`seq`);--> statement-breakpoint
CREATE TABLE `game_winrates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`good_pct` integer NOT NULL,
	`wolf_pct` integer NOT NULL,
	`reasons` text NOT NULL,
	`trigger_label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_winrates_game_id` ON `game_winrates` (`game_id`,`id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`board_name` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`winner` text,
	`day_count` integer DEFAULT 1 NOT NULL,
	`player_count` integer NOT NULL,
	`setup` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guide_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text DEFAULT 'common' NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`game_id` text,
	`note` text DEFAULT '' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`remember` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`avatar` text NOT NULL,
	`password_hash` text NOT NULL,
	`settings` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
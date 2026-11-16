CREATE TABLE `api_presets` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`name` varchar(64) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`base_url` varchar(256) NOT NULL DEFAULT '',
	`model` varchar(128) NOT NULL DEFAULT '',
	`api_key` varchar(512) NOT NULL DEFAULT '',
	`user_id` varchar(36),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `api_presets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_analyses` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`game_id` varchar(36) NOT NULL,
	`report` text NOT NULL,
	`model` varchar(128) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_analyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_decisions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`game_id` varchar(36) NOT NULL,
	`idx` int NOT NULL,
	`kind` varchar(32) NOT NULL,
	`seat` int NOT NULL,
	`decision` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`game_id` varchar(36) NOT NULL,
	`seq` int NOT NULL,
	`day` int NOT NULL,
	`phase` varchar(64) NOT NULL,
	`type` varchar(16) NOT NULL,
	`actor` int,
	`actor_label` varchar(32),
	`title` varchar(128) NOT NULL,
	`content` text NOT NULL,
	`thought` text,
	`meta` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_winrates` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`game_id` varchar(64) NOT NULL,
	`day` int NOT NULL,
	`phase` varchar(64) NOT NULL,
	`good_pct` int NOT NULL,
	`wolf_pct` int NOT NULL,
	`reasons` json NOT NULL,
	`trigger_label` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_winrates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` varchar(36) NOT NULL,
	`board_id` varchar(64) NOT NULL,
	`board_name` varchar(128) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'created',
	`winner` varchar(8),
	`day_count` int NOT NULL DEFAULT 1,
	`player_count` int NOT NULL,
	`setup` json NOT NULL,
	`user_id` varchar(36),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `games_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `guide_versions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`scope` varchar(32) NOT NULL DEFAULT 'common',
	`version` int NOT NULL,
	`content` text NOT NULL,
	`game_id` varchar(36),
	`note` varchar(255) NOT NULL DEFAULT '',
	`user_id` varchar(36),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `guide_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`remember` int NOT NULL DEFAULT 0,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`username` varchar(64) NOT NULL,
	`avatar` text NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`settings` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_game_idx` ON `game_decisions` (`game_id`,`idx`);--> statement-breakpoint
CREATE INDEX `idx_game_seq` ON `game_events` (`game_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_winrates_game_id` ON `game_winrates` (`game_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);
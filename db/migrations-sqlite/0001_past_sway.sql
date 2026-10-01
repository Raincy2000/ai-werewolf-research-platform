CREATE TABLE `game_studies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`seat` integer NOT NULL,
	`notes` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_studies_game` ON `game_studies` (`game_id`,`seat`);--> statement-breakpoint
CREATE TABLE `library_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`content` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);

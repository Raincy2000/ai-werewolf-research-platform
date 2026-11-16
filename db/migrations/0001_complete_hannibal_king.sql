CREATE TABLE `game_studies` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`game_id` varchar(36) NOT NULL,
	`seat` int NOT NULL,
	`notes` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_studies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `library_docs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`format` varchar(16) NOT NULL,
	`content` longtext NOT NULL,
	`size_bytes` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `library_docs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_studies_game` ON `game_studies` (`game_id`,`seat`);
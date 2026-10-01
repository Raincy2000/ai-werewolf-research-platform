CREATE TABLE `persona_drift_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`persona_id` integer NOT NULL,
	`game_id` text,
	`changes` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pdrift_persona` ON `persona_drift_log` (`persona_id`);--> statement-breakpoint
CREATE TABLE `persona_memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`persona_id` integer NOT NULL,
	`game_id` text,
	`type` text DEFAULT 'general' NOT NULL,
	`content` text NOT NULL,
	`emotional_weight` integer DEFAULT 50 NOT NULL,
	`strength` integer DEFAULT 50 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pmem_persona` ON `persona_memories` (`persona_id`);--> statement-breakpoint
CREATE TABLE `persona_relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`persona_id` integer NOT NULL,
	`target_persona_id` integer,
	`target_name` text NOT NULL,
	`relation` text DEFAULT '' NOT NULL,
	`affinity` integer DEFAULT 0 NOT NULL,
	`trust` integer DEFAULT 50 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`game_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_prel_persona` ON `persona_relationships` (`persona_id`);--> statement-breakpoint
CREATE TABLE `persona_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`persona_id` integer NOT NULL,
	`seat` integer NOT NULL,
	`report` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_preport_game` ON `persona_reports` (`game_id`,`persona_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`origin_name` text,
	`origin_source` text,
	`profile` text NOT NULL,
	`params` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`game_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_personas_user` ON `personas` (`user_id`);
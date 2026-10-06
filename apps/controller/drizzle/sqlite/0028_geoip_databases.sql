CREATE TABLE `geoip_databases` (
	`edition` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`data` blob NOT NULL,
	`updatedAt` text NOT NULL
);

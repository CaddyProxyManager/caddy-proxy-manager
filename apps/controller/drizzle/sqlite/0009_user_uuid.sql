-- Opaque user ids for forward auth. Existing rows are filled at startup: SQL cannot make a UUIDv7.
ALTER TABLE `users` ADD `uuid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_uuid_unique` ON `users` (`uuid`);--> statement-breakpoint
-- Upstreams of an install that already has users are keyed on the numeric id; keep sending it.
INSERT INTO `settings` (`key`, `value`, `updatedAt`)
SELECT 'config:forward_auth_sequential_user_ids', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM `users`)
ON CONFLICT (`key`) DO NOTHING;

-- The audit page's actor and action filters, the hourly sweep of expired sessions, and two tables
-- nothing has read or written since the OAuth flow moved into Better Auth.
DROP TABLE `oauth_states`;--> statement-breakpoint
DROP TABLE `pending_oauth_links`;--> statement-breakpoint
CREATE INDEX `audit_events_user_idx` ON `audit_events` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`,`createdAt`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expiresAt`);
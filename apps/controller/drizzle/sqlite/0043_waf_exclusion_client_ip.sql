-- WAF exclusions scoped to a client address or CIDR range.
ALTER TABLE `waf_exclusions` ADD `clientIp` text;

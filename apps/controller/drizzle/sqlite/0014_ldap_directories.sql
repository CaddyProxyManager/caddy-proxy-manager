-- LDAP directories: oauth_providers rows with type='ldap'.
ALTER TABLE `oauth_providers` ADD `ldapConfig` text;

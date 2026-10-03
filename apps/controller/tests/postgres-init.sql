-- The extra databases the end-to-end stack's additional web instances need.
--
-- docker-compose.yml's postgres service creates one database; the suite runs six web containers
-- (web, web-registration-enabled, web-setup, web-migrate, web-ratelimit, web-demo) and each needs
-- its own, because they
-- assert on each other's data being separate - and the last two must start empty, which is what
-- puts them in the first-run setup flow. Run by the postgres image from
-- /docker-entrypoint-initdb.d on first initialization only, which is every run: the suite tears
-- the volume down with `down -v`.
CREATE DATABASE cpm_registration OWNER cpm;
CREATE DATABASE cpm_setup OWNER cpm;
CREATE DATABASE cpm_migrate OWNER cpm;
CREATE DATABASE cpm_ratelimit OWNER cpm;
CREATE DATABASE cpm_demo OWNER cpm;

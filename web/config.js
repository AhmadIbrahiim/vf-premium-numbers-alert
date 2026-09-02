/**
 * config.js — where the dashboard finds its data.
 *
 * The pages read Postgres directly through Neon's Data API (PostgREST). Fill this in
 * once, after enabling the Data API on the Neon project:
 *
 *   Neon console -> project -> Data API -> Enable
 *
 * `base` is the REST root it gives you, e.g.
 *   https://ep-xxxx.apirest.c-4.us-east-2.aws.neon.tech/neondb/rest/v1
 *
 * `token` is only needed if the Data API is left behind Neon Auth. With anonymous read
 * enabled it stays empty, which is the intended setup here: the anonymous role is
 * granted SELECT on three tables and nothing else (see db/grants.sql), and the data is
 * the carriers' own public listings.
 *
 * NEVER put a Postgres connection string in this file — it is served to every visitor.
 */
window.VF_CONFIG = {
  base: "",
  token: "",
  /** Polls to chart on the status page. */
  statusWindow: 48,
  /** How often the status page refreshes itself, in seconds. */
  refreshSeconds: 60,
};

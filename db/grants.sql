-- grants.sql — what the Data API's anonymous role is allowed to see.
--
-- Run this ONCE, after enabling the Data API on the Neon project (that step is what
-- creates the `anonymous` role). Everything here is deliberately narrow:
--
--   * SELECT only. No INSERT/UPDATE/DELETE, no sequences, no functions.
--   * Three tables only. `meta` is excluded: it holds the LLM grade cache and the run
--     signature, which are pipeline internals and none of a visitor's business.
--   * Row-level security is enabled with a read-only policy on each table, so a future
--     accidental GRANT cannot widen access on its own.
--
-- The rows exposed are the carriers' own public listings, already published on their
-- shops. Nothing here is personal data.

-- Never let the anonymous role reach the whole schema by default.
revoke all on all tables in schema public from anonymous;
revoke all on schema public from anonymous;
grant usage on schema public to anonymous;

-- The three readable tables.
grant select on numbers        to anonymous;
grant select on provider_runs  to anonymous;
grant select on number_events  to anonymous;

alter table numbers       enable row level security;
alter table provider_runs enable row level security;
alter table number_events enable row level security;

drop policy if exists anon_read_numbers       on numbers;
drop policy if exists anon_read_provider_runs on provider_runs;
drop policy if exists anon_read_number_events on number_events;

create policy anon_read_numbers       on numbers       for select to anonymous using (true);
create policy anon_read_provider_runs on provider_runs for select to anonymous using (true);
create policy anon_read_number_events on number_events for select to anonymous using (true);

-- Belt and braces: `meta` must never be readable by the anonymous role.
revoke all on meta from anonymous;
alter table meta enable row level security;

-- Cap what one anonymous query can cost, so a hostile caller cannot burn compute.
alter role anonymous set statement_timeout = '5s';

-- Skin Receipts — database schema (Postgres)
-- Draft for review. No accounts anywhere — chat and threads are anonymous,
-- identified only by a random session_id stored client-side.

create extension if not exists pgcrypto;
-- pg_trgm powers fuzzy ingredient matching in /api/check, so OCR misreads
-- ("Dimeticone", "Clyceryl Stearate") still resolve to the right INCI name.
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Ingredients & products (Phase 0/1/2)
-- ---------------------------------------------------------------------------

create table if not exists ingredients (
  id                  uuid primary key default gen_random_uuid(),
  inci_name           text not null,                 -- canonical name
  aliases             text[] not null default '{}',  -- alternate/common names to match against
  comedogenic_rating  smallint check (comedogenic_rating between 0 and 5), -- graded 0-5, only when a numeric source exists
  pore_clogging       boolean,                        -- flagged on a known pore-clogging reference list (no numeric grade given)
  fungal_acne_risk    text check (fungal_acne_risk in ('low', 'medium', 'high')), -- malassezia-feeding risk tier
  source              text,                           -- citation, e.g. "CosIng", "Fulton 1984"
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ingredients_inci_name_idx on ingredients (lower(inci_name));
create index if not exists ingredients_inci_name_trgm_idx on ingredients using gin (lower(inci_name) gin_trgm_ops);

-- Suffix/keyword heuristics for matching ingredients not found verbatim in
-- the table above (e.g. an unlisted "... Palmitate" ester still reads as
-- high fungal-acne risk because of the "Palmitate" suffix).
create table if not exists keyword_risk_rules (
  keyword           text primary key,
  fungal_acne_risk  text not null check (fungal_acne_risk in ('low', 'medium', 'high')),
  notes             text,
  created_at        timestamptz not null default now()
);

create table if not exists products (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  brand            text,
  category         text,                     -- e.g. "moisturizer", "sunscreen"
  image_url        text,
  raw_ingredients  text,                      -- pasted/scanned ingredient list as text
  fungal_safe      boolean not null default false,
  non_comedogenic  boolean not null default false,
  source           text,                      -- where this product's data was verified
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- links a product's parsed ingredient list to known ingredients, in order
create table if not exists product_ingredients (
  product_id    uuid not null references products(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  position      smallint not null,            -- order in the ingredient list (INCI lists are ordered by concentration)
  primary key (product_id, ingredient_id)
);

create index if not exists product_ingredients_product_idx on product_ingredients (product_id);

-- ---------------------------------------------------------------------------
-- Anonymous sessions (shared by chat + threads)
-- ---------------------------------------------------------------------------

create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(), -- the client-side session_id
  nickname    text,                                        -- optional, self-chosen
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Ephemeral anonymous chat (Phase 3) — one single global chat, no rooms.
-- Messages expire ~1 week after creation. "Number of people online" is a
-- live count of active socket connections (tracked in Redis/in-memory at
-- the app layer), not a Postgres-backed value — it's not something that
-- needs durability or history.
-- ---------------------------------------------------------------------------

create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id),
  body        text,                          -- nullable if message is image-only
  image_url   text,                          -- set only after passing NSFW gate
  hidden      boolean not null default false, -- true once a report is upheld/pending review
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days')
);

create index if not exists chat_messages_created_idx on chat_messages (created_at);
create index if not exists chat_messages_expires_idx on chat_messages (expires_at); -- for the TTL cleanup job

-- ---------------------------------------------------------------------------
-- Community threads (Phase 4) — longer-lived, no TTL by default
-- ---------------------------------------------------------------------------

create table if not exists posts (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id),
  title       text not null,
  body        text not null,
  image_url   text,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists comments (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references posts(id) on delete cascade,
  parent_comment_id uuid references comments(id) on delete cascade, -- null = top-level comment, set = reply
  session_id        uuid not null references sessions(id),
  body              text not null,
  hidden            boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists comments_post_idx on comments (post_id, created_at);
create index if not exists comments_parent_idx on comments (parent_comment_id);

-- ---------------------------------------------------------------------------
-- Reporting (shared by chat messages, posts, comments)
-- ---------------------------------------------------------------------------

create table if not exists reports (
  id                uuid primary key default gen_random_uuid(),
  target_type       text not null check (target_type in ('chat_message', 'post', 'comment')),
  target_id         uuid not null,           -- polymorphic FK, validated at the app layer
  reporter_session_id uuid not null references sessions(id),
  reason            text,
  status            text not null default 'pending' check (status in ('pending', 'dismissed', 'upheld')),
  created_at        timestamptz not null default now(),
  reviewed_at       timestamptz
);

create index if not exists reports_target_idx on reports (target_type, target_id);
create index if not exists reports_status_idx on reports (status);

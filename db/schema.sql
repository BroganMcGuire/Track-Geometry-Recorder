-- Schema for the Supabase (PostgreSQL) database that stores the recorded runs.
--
-- Runs are recorded on the phone and kept in IndexedDB first; this schema is
-- the shared copy used by the maintenance team. The raw acceleration and GNSS
-- datasheets stay as JSON documents (they are large and only ever read as a
-- whole), while the journey information and the exceeded thresholds are stored
-- as columns so that they can be queried by ELR, track and mileage.

create table if not exists runs (
  id                  text primary key,
  elr                 text not null,
  track               text,
  train_type          text,
  position_in_train   text,
  initial_mileage_mi  double precision not null default 0,
  mileage_direction   smallint not null default 1,
  started_at          timestamptz not null,
  duration_s          double precision,
  samples             integer,
  fixes               integer,
  rate_hz             double precision,
  meta                jsonb not null default '{}'::jsonb,
  acceleration        jsonb not null default '[]'::jsonb,
  gnss                jsonb not null default '[]'::jsonb,
  markers             jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists runs_elr_track_idx on runs (elr, track);
create index if not exists runs_started_at_idx on runs (started_at desc);

create table if not exists threshold_events (
  id          bigserial primary key,
  run_id      text not null references runs (id) on delete cascade,
  elr         text,
  track       text,
  channel     text not null,
  level       text not null,
  value_ms2   double precision not null,
  limit_ms2   double precision,
  mileage_mi  double precision,
  distance_m  double precision,
  length_m    double precision,
  latitude    double precision,
  longitude   double precision
);

-- Added with the ELR/track/mileage support: keep older databases up to date.
alter table threshold_events add column if not exists elr text;
alter table threshold_events add column if not exists track text;

create index if not exists threshold_events_run_idx on threshold_events (run_id);
create index if not exists threshold_events_mileage_idx on threshold_events (mileage_mi);
create index if not exists threshold_events_elr_idx on threshold_events (elr, track, mileage_mi);

-- מרכז בקרה פרסומי — סכימה
-- הקובץ ניתן להרצה חוזרת (idempotent): כל create הוא if not exists.

create table if not exists users (
  id            serial primary key,
  name          text not null,
  email         text not null unique,
  password_hash text not null,
  is_owner      boolean not null default false,
  perm_content  boolean not null default true,   -- תוכן ושיבוץ
  perm_settings boolean not null default false,  -- הגדרות
  perm_approve  boolean not null default false,  -- אישור דחוף־דורס
  perm_users    boolean not null default false,  -- ניהול משתמשים
  created_at    timestamptz not null default now()
);

create table if not exists endpoints (
  id               serial primary key,
  name             text not null,
  importance       int not null default 5 check (importance between 1 and 10),
  min_days_between int not null default 7,
  active           boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists channels (
  id                   serial primary key,
  name                 text not null,
  max_per_week         int not null default 5,
  max_promo_per_week   int,
  max_hybrid_per_week  int,
  max_value_per_week   int,
  urgent_reserve_pct   int not null default 20,
  active               boolean not null default true,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now()
);

create table if not exists campaigns (
  id          serial primary key,
  endpoint_id int not null references endpoints(id) on delete cascade,
  name        text not null,
  starts_on   date,
  ends_on     date,
  share_pct   int,
  urgent      boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists content_items (
  id                serial primary key,
  endpoint_id       int not null references endpoints(id) on delete cascade,
  kind              text not null check (kind in ('promo','value','hybrid')),
  title             text not null,
  body              text not null default '',
  ready_channel_ids int[] not null default '{}',
  created_at        timestamptz not null default now()
);

create table if not exists posts (
  id           serial primary key,
  channel_id   int not null references channels(id) on delete cascade,
  endpoint_id  int references endpoints(id) on delete set null,
  content_id   int references content_items(id) on delete set null,
  title        text not null,
  kind         text not null check (kind in ('promo','value','hybrid')),
  scheduled_at timestamptz not null,
  status       text not null default 'scheduled'
               check (status in ('scheduled','published','pending_approval','hole')),
  assignee_id  int references users(id) on delete set null,
  urgent       boolean not null default false,
  note         text,
  published_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists posts_scheduled_at_idx on posts (scheduled_at);
create index if not exists posts_channel_idx      on posts (channel_id);
create index if not exists posts_endpoint_idx     on posts (endpoint_id);

create table if not exists strategy_allocations (
  id           serial primary key,
  period_kind  text not null check (period_kind in ('quarter','half','year')),
  period_label text not null,
  starts_on    date not null,
  ends_on      date not null,
  endpoint_id  int not null references endpoints(id) on delete cascade,
  target_pct   int not null check (target_pct between 0 and 100),
  label        text
);

create table if not exists strategy_milestones (
  id          serial primary key,
  endpoint_id int references endpoints(id) on delete cascade,
  label       text not null,
  on_date     date not null
);

create table if not exists tasks (
  id          serial primary key,
  title       text not null,
  subtitle    text,
  kind        text not null default 'general'
              check (kind in ('publish','write','approve','general')),
  post_id     int references posts(id) on delete cascade,
  endpoint_id int references endpoints(id) on delete set null,
  assignee_id int references users(id) on delete set null,
  due_on      date,
  urgent      boolean not null default false,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists engine_settings (
  id                  int primary key default 1 check (id = 1),
  min_gap_days        int not null default 7,
  max_promo_per_day   int not null default 1,
  hybrid_weight       numeric(3,2) not null default 0.5,
  content_alert_hours int not null default 48
);

insert into engine_settings (id) values (1) on conflict (id) do nothing;

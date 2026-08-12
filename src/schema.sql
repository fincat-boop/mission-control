-- מרכז בקרה פרסומי — סכימה
-- הקובץ ניתן להרצה חוזרת (idempotent): כל create הוא if not exists.

-- ========================= מולטי-טננט =========================
-- ארגון = טננט. כל טבלת-דומיין נושאת org_id (ראו הסעיף בתחתית הקובץ).
-- שלב 1 הוא אדיטיבי: org_id nullable, ה-backfill והמעבר ל-NOT NULL + RLS
-- באים בשלבים הבאים. ראו docs/multi-tenant-plan.md.
create table if not exists orgs (
  id         serial primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

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
  -- ריק = אוטומטי (נגזר מהחשיבות, ראו effectiveCadenceDays ב-board.js).
  -- מספר = override מפורש לצורך ספציפי, בלי קשר לחשיבות.
  min_days_between int,
  active           boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now()
);

-- קיים מ-DB ישן עם not null default 7 — ריק הופך עכשיו לאוטומטי.
-- נקודות קצה קיימות שומרות על הערך המפורש שהיה להן, בלי שינוי התנהגות.
alter table endpoints alter column min_days_between drop not null;
alter table endpoints alter column min_days_between drop default;

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

-- הקצב הרצוי של המדיה, להבדיל מ-max_per_week שהוא תקרה.
-- ממנו נגזר כמה פוסטים מגיעים לכל קמפיין שיושב על המדיה הזו.
alter table channels
  add column if not exists target_per_week numeric(4,1);

-- ימים בשבוע שבהם המדיה לא מקבלת תוכן. 0 = ראשון ... 6 = שבת.
alter table channels
  add column if not exists blocked_days int[] not null default '{}';

-- כמה יעיל לפרסם במדיה הזו (1–10). אופציונלי — ריק = ניטרלי, לא משפיע
-- על כלום. כשמוגדר, המנוע מנסה למלא קודם משבצות של מדיות יעילות יותר,
-- כדי שתוכן חשוב (חוב אוויר גבוה) יקבל קדימות על הבמה הטובה. ראו
-- buildSlots ב-engine.js.
alter table channels
  add column if not exists efficiency int check (efficiency between 1 and 10);

-- קמפיין הוא היחידה המרכזית: הוא נושא את התאריכים, החשיבות, הקצב והנתח.
-- הוא ירש את התפקיד של strategy_allocations, שנמחקה.
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

-- השהיה: הקמפיין שומר על התאריכים והתוכן שלו, אבל מפסיק להזין את המנוע
-- והשיבוצים שטרם יצאו יורדים מהלוח. הכול חוזר בלחיצה, בלי לאבד דבר.
alter table campaigns
  add column if not exists paused_at timestamptz;

alter table campaigns
  add column if not exists importance int not null default 5,
  -- דריסה ידנית של מספר הזוויות. null = נגזר מהתדירות של המדיות ומהנתח.
  add column if not exists target_posts int,
  add column if not exists goal text;

-- cadence_days ישב על הקמפיין וירד ממנו: התדירות שייכת למדיה, לא לקמפיין.
-- ראה src/migrations/002-channel-cadence-and-variants.js
alter table campaigns drop column if exists cadence_days;

do $$ begin
  alter table campaigns add constraint campaigns_importance_range
    check (importance between 1 and 10);
exception when duplicate_object then null; end $$;

-- על אילו מדיות הקמפיין יושב
create table if not exists campaign_channels (
  campaign_id int not null references campaigns(id) on delete cascade,
  channel_id  int not null references channels(id)  on delete cascade,
  primary key (campaign_id, channel_id)
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

-- תוכן יכול להשתייך לקמפיין ולהיות מסודר בתוכו. בלי קמפיין = תוכן שוטף.
alter table content_items
  add column if not exists campaign_id int references campaigns(id) on delete set null,
  add column if not exists sort_order int not null default 0;

-- evergreen: תוכן שאפשר לפרסם שוב ושוב. ברירת המחדל היא חד-פעמי,
-- כדי שפוסט השקה לא יחזור לאוויר מעצמו.
-- reuse_after_days = כמה ימים להמתין בין חזרה לחזרה. null = min_gap_days של המנוע.
alter table content_items
  add column if not exists evergreen boolean not null default false,
  add column if not exists reuse_after_days int;

-- content_items הוא הזווית. הניסוח לכל מדיה יושב בגרסה נפרדת,
-- כי אותה זווית נכתבת אחרת בפייסבוק, בניוזלטר ובוואטסאפ.
create table if not exists content_variants (
  id         serial primary key,
  content_id int not null references content_items(id) on delete cascade,
  channel_id int not null references channels(id) on delete cascade,
  body       text not null default '',
  -- not_relevant = הוחלט במפורש שהזווית הזו לא הולכת למדיה הזו,
  -- ולכן התא לא נספר כחוסר
  status     text not null default 'draft'
             check (status in ('draft', 'ready', 'not_relevant')),
  created_at timestamptz not null default now(),
  unique (content_id, channel_id)
);

create index if not exists content_variants_content_idx on content_variants (content_id);

create index if not exists content_campaign_idx on content_items (campaign_id, sort_order);

-- קבצים מצורפים לתוכן: תמונה, מסמך, כל דבר.
-- נשמרים במסד ולא בדיסק, כדי שסקריפט הגיבוי יכסה אותם כמו כל השאר.
create table if not exists content_assets (
  id          serial primary key,
  content_id  int not null references content_items(id) on delete cascade,
  filename    text not null,
  mime        text not null,
  size_bytes  int not null,
  data        bytea not null,
  created_at  timestamptz not null default now()
);

create index if not exists content_assets_content_idx on content_assets (content_id);

-- קובץ יכול להיות משותף לכל המדיות (variant_id ריק) או שייך לגרסה אחת:
-- הריל לאינסטגרם והתמונה לפייסבוק הם קבצים שונים לאותה זווית.
alter table content_assets
  add column if not exists variant_id int references content_variants(id) on delete cascade;

create index if not exists content_assets_variant_idx on content_assets (variant_id);

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
-- צבירת היעילות מסננת על published_at, ולכן הוא צריך אינדקס משלו
create index if not exists posts_published_at_idx on posts (published_at);

-- ========================= תוצאות בפועל =========================
-- מה באמת קרה לפוסט אחרי שיצא. שורה אחת לפוסט (מפתח ראשי על post_id).
--
-- כל המדדים nullable בכוונה: ריק פירושו "לא נמדד", לא "אפס". מדד חסר
-- לא נכנס לחישוב היעילות — לא למונה ולא למכנה — כך שאפשר למלא רק את
-- מה שבאמת יש בלי לעוות את התוצאה. ראו src/performance.js.
create table if not exists post_results (
  post_id     int primary key references posts(id) on delete cascade,
  reach       int check (reach >= 0),
  engagement  int check (engagement >= 0),
  clicks      int check (clicks >= 0),
  leads       int check (leads >= 0),
  note        text,
  updated_at  timestamptz not null default now()
);

-- strategy_allocations הוסרה. התוכן שלה עבר ל-campaigns.
-- ראה src/migrations/001-campaigns-absorb-strategy.js

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
              check (kind in ('publish','write','approve','general','swap')),
  post_id     int references posts(id) on delete cascade,
  endpoint_id int references endpoints(id) on delete set null,
  assignee_id int references users(id) on delete set null,
  due_on      date,
  urgent      boolean not null default false,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- 'swap' — הצעת המנוע להחליף פוסט בלי תוכן בתוכן מוכן של נקודה אחרת,
-- כשמתקרבים למועד הפרסום. meta נושא את פרטי ההצעה (content_id/endpoint_id
-- מוצעים) כדי שהפעולה בממשק לא תצטרך לחשב אותם מחדש.
alter table tasks drop constraint if exists tasks_kind_check;
alter table tasks add constraint tasks_kind_check
  check (kind in ('publish','write','approve','general','swap'));
alter table tasks add column if not exists meta jsonb;

create table if not exists engine_settings (
  id                  int primary key default 1 check (id = 1),
  min_gap_days        int not null default 7,
  max_promo_per_day   int not null default 1,
  hybrid_weight       numeric(3,2) not null default 0.5,
  content_alert_hours int not null default 48
);

-- כמה פוסטי ערך נדרשים על כל פוסט מכירתי. המנוע לא יחרוג מזה.
alter table engine_settings
  add column if not exists min_value_per_promo numeric(3,1) not null default 3;

-- האם היעילות הנמדדת (post_results) משפיעה בפועל על השיבוץ.
-- כבוי כברירת מחדל: קודם אוספים נתונים ורואים שהם הגיוניים, ורק אז
-- נותנים להם להזיז את הלוח.
alter table engine_settings
  add column if not exists use_performance boolean not null default false;

insert into engine_settings (id) values (1) on conflict (id) do nothing;

-- ========================= יומן פעולות =========================
-- מי עשה מה ומתי. נכתב אוטומטית לכל בקשה שמשנה נתונים, כולל פעולות
-- שהעוזר הציע והמשתמש אישר — הן עוברות באותם נתיבים ולכן נרשמות זהה.
create table if not exists activity_log (
  id         bigserial primary key,
  user_id    int references users(id) on delete set null,
  user_name  text not null,              -- נשמר בנפרד כדי שמחיקת משתמש לא תמחק היסטוריה
  via        text not null default 'ui'
             check (via in ('ui','assistant','system')),
  action     text not null,              -- create / update / delete / publish / approve / login ...
  entity     text not null,              -- posts / campaigns / content ...
  entity_id  text,
  summary    text not null,              -- תיאור בעברית לקריאה אנושית
  meta       jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_time_idx on activity_log (created_at desc);
create index if not exists activity_log_user_idx on activity_log (user_id, created_at desc);

-- ========================= גיבוי אוטומטי =========================
-- תמונת מצב תקופתית של הטבלאות היחסיות (בלי בייטים של קבצים מצורפים —
-- הם כבר בטוחים בעצמם ב-content_assets, וכפילות שלהם כאן הייתה ממלאת
-- את ה-volume מהר). מגן מפני טעות ברמת האפליקציה, לא מפני אובדן הדיסק
-- עצמו — לזה יש את הגיבוי המובנה של Railway ל-Postgres.
create table if not exists backups (
  id         serial primary key,
  created_at timestamptz not null default now(),
  row_count  int not null,
  payload    jsonb not null
);

create index if not exists backups_created_at_idx on backups (created_at desc);

-- ========================= הגבלת קצב בהתחברות =========================
-- ניסיונות התחברות כושלים, להגנה מפני brute-force. מבוסס-DB ולא מונה
-- בזיכרון — כדי שיהיה עמיד ל-req.ip לא יציב מאחורי הפרוקסי ולריבוי
-- instances. ממופתח לפי אימייל (היעד של המתקפה); מתאפס בהתחברות מוצלחת.
create table if not exists login_attempts (
  id    serial primary key,
  email text not null,
  ip    text,
  at    timestamptz not null default now()
);

create index if not exists login_attempts_email_idx on login_attempts (email, at desc);

-- ========================= org_id לכל טבלת-דומיין =========================
-- שלב 1 (אדיטיבי): העמודה nullable, מסונכרנת ל-org בברירת מחדל דרך
-- src/migrations/003-multi-tenant-base.js. המעבר ל-NOT NULL + FORCE RLS
-- מתבצע בשלב מאוחר יותר, אחרי שהאפליקציה כותבת org_id בכל insert.
-- ראו docs/multi-tenant-plan.md.
--
-- טבלאות שורש + בנות (org_id denormalized גם בבנות, כדי ש-policy ה-RLS
-- יהיה אחיד ופשוט).
alter table users               add column if not exists org_id int references orgs(id);
alter table endpoints           add column if not exists org_id int references orgs(id);
alter table channels            add column if not exists org_id int references orgs(id);
alter table campaigns           add column if not exists org_id int references orgs(id);
alter table campaign_channels   add column if not exists org_id int references orgs(id);
alter table content_items       add column if not exists org_id int references orgs(id);
alter table content_variants    add column if not exists org_id int references orgs(id);
alter table content_assets      add column if not exists org_id int references orgs(id);
alter table posts               add column if not exists org_id int references orgs(id);
alter table post_results        add column if not exists org_id int references orgs(id);
alter table strategy_milestones add column if not exists org_id int references orgs(id);
alter table tasks               add column if not exists org_id int references orgs(id);
alter table activity_log        add column if not exists org_id int references orgs(id);
-- engine_settings: היום סינגלטון (check id=1). בשלב 1 רק מוסיפים org_id;
-- המעבר ל-PK per-org והחלפת where id=1 בקוד באים בשלב מאוחר יותר.
alter table engine_settings     add column if not exists org_id int references orgs(id);

-- אינדקסים מורכבים עם org_id מוביל, על הנתיבים החמים.
create index if not exists posts_org_scheduled_idx   on posts (org_id, scheduled_at);
create index if not exists content_org_campaign_idx  on content_items (org_id, campaign_id);
create index if not exists campaigns_org_idx         on campaigns (org_id);
create index if not exists endpoints_org_idx         on endpoints (org_id);
create index if not exists channels_org_idx          on channels (org_id);
create index if not exists tasks_org_idx             on tasks (org_id);

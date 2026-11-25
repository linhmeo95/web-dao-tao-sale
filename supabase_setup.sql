-- ============================================================================
-- CODE SQL KHỞI TẠO BẢNG SUPABASE CHO APP: CẨM NANG TƯ VẤN MẦM NON CHUYỂN GIAO
-- Hướng dẫn: Copy toàn bộ đoạn code này dán vào mục "SQL Editor" trên Supabase
-- rồi bấm nút "Run" (hoặc Ctrl + Enter).
-- ============================================================================

-- 1. Tạo bảng lưu trữ trạng thái ứng dụng, học phần, câu hỏi và tiến độ Sale
create table if not exists public.novastars_app_state (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Tạo index hỗ trợ truy vấn nhanh theo tiền tố id (sale_training__*)
create index if not exists idx_novastars_app_state_updated_at
  on public.novastars_app_state (updated_at desc);

-- 3. Cấp quyền truy cập qua Data API (PostgREST) cho role anon và authenticated
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.novastars_app_state to anon, authenticated;

-- 4. Bật Row Level Security (RLS) và tạo Policy cho phép App đồng bộ dữ liệu
alter table public.novastars_app_state enable row level security;

drop policy if exists "Allow anon and authenticated select novastars_app_state" on public.novastars_app_state;
create policy "Allow anon and authenticated select novastars_app_state"
  on public.novastars_app_state
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Allow anon and authenticated insert novastars_app_state" on public.novastars_app_state;
create policy "Allow anon and authenticated insert novastars_app_state"
  on public.novastars_app_state
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Allow anon and authenticated update novastars_app_state" on public.novastars_app_state;
create policy "Allow anon and authenticated update novastars_app_state"
  on public.novastars_app_state
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Allow anon and authenticated delete novastars_app_state" on public.novastars_app_state;
create policy "Allow anon and authenticated delete novastars_app_state"
  on public.novastars_app_state
  for delete
  to anon, authenticated
  using (true);

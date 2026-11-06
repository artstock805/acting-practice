-- AI 분석 크레딧 원장 (Supabase SQL Editor에서 한 번 실행)
-- 잔액은 따로 저장하지 않고 이 표의 amount 합으로 셈. 서버(service_role 키)만 읽고 씀:
-- RLS를 켜고 정책을 두지 않아 브라우저용 키(anon·authenticated)로는 표도 함수도 쓸 수 없음
-- 1크레딧 = 10원, AI 분석 1회 = 100크레딧. 결제(토스페이먼츠)로 충전하면 payment_orders에 주문을, 원장에 'charge'를 남김

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  client_id text not null,                 -- 시험 단계: 브라우저마다 만든 임시 ID (로그인을 붙이면 사용자 ID)
  type text not null,
  amount integer not null check (amount <> 0),
  script_hash text,                        -- 대본 내용의 SHA-256 (같은 대본은 24시간 동안 한 번만 차감)
  request_id text unique,                  -- 같은 요청이 두 번 와도 한 번만 차감
  ref bigint references public.credit_ledger (id),  -- 환불이 되돌리는 차감
  created_at timestamptz not null default now(),
  check (type <> 'analysis' or (amount < 0 and script_hash is not null and request_id is not null)),
  check (type <> 'refund' or (amount > 0 and ref is not null)),
  check (type <> 'grant' or amount > 0)
);

-- 차감 하나는 한 번만 환불
-- 처음 만든 뒤에 더한 것 (이미 만든 표에도 다시 실행하면 적용됨)
alter table public.credit_ledger add column if not exists order_id text unique;   -- 충전이 어느 주문의 것인지 (주문 하나는 한 번만 충전)
alter table public.credit_ledger drop constraint if exists credit_ledger_type_check;
alter table public.credit_ledger add constraint credit_ledger_type_check check (type in ('grant', 'charge', 'analysis', 'refund'));
alter table public.credit_ledger drop constraint if exists credit_ledger_charge_check;
alter table public.credit_ledger add constraint credit_ledger_charge_check check (type <> 'charge' or (amount > 0 and order_id is not null));

create unique index if not exists credit_ledger_one_refund on public.credit_ledger (ref) where type = 'refund';
create index if not exists credit_ledger_client on public.credit_ledger (client_id, created_at);
create index if not exists credit_ledger_client_script on public.credit_ledger (client_id, script_hash) where type = 'analysis';

alter table public.credit_ledger enable row level security;
revoke all on public.credit_ledger from anon, authenticated;

create or replace function public.credit_balance(p_client_id text)
returns integer language sql stable set search_path = public as $$
  select coalesce(sum(amount), 0)::integer from credit_ledger where client_id = p_client_id;
$$;

-- AI 분석 1회 차감. 결과 status:
--   charged      이번에 차감함 (ledger_id로 환불 가능)
--   covered      같은 대본을 24시간 안에 이미 차감함 (추가 차감 없음)
--   duplicate    같은 request_id가 이미 처리됨 (추가 차감 없음)
--   insufficient 잔액 부족
create or replace function public.spend_analysis(p_client_id text, p_script_hash text, p_request_id text, p_cost integer default 100)
returns jsonb language plpgsql set search_path = public as $$
declare
  bal integer;
  new_id bigint;
  owner text;
begin
  if p_cost <= 0 then raise exception 'cost must be positive'; end if;
  -- 같은 사람의 차감은 한 번에 하나씩 (동시에 눌러도 잔액보다 많이 빠지지 않게)
  perform pg_advisory_xact_lock(hashtextextended(p_client_id, 0));

  select client_id into owner from credit_ledger where request_id = p_request_id;
  if found then
    if owner <> p_client_id then raise exception 'request_id belongs to another client'; end if;
    return jsonb_build_object('status', 'duplicate', 'balance', credit_balance(p_client_id));
  end if;

  -- 환불된 차감은 '이미 낸 것'으로 치지 않음
  if exists (
    select 1 from credit_ledger a
    where a.client_id = p_client_id and a.type = 'analysis' and a.script_hash = p_script_hash
      and a.created_at > now() - interval '24 hours'
      and not exists (select 1 from credit_ledger r where r.type = 'refund' and r.ref = a.id)
  ) then
    return jsonb_build_object('status', 'covered', 'balance', credit_balance(p_client_id));
  end if;

  bal := credit_balance(p_client_id);
  if bal < p_cost then
    return jsonb_build_object('status', 'insufficient', 'balance', bal);
  end if;

  insert into credit_ledger (client_id, type, amount, script_hash, request_id)
  values (p_client_id, 'analysis', -p_cost, p_script_hash, p_request_id)
  returning id into new_id;
  return jsonb_build_object('status', 'charged', 'ledger_id', new_id, 'balance', bal - p_cost);
end;
$$;

-- Claude 호출이 실패했을 때 차감을 되돌림. 두 번 불러도 한 번만 환불
create or replace function public.refund_analysis(p_ledger_id bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  spent credit_ledger;
begin
  select * into spent from credit_ledger where id = p_ledger_id and type = 'analysis';
  if not found then raise exception 'no analysis entry %', p_ledger_id; end if;
  insert into credit_ledger (client_id, type, amount, script_hash, ref)
  values (spent.client_id, 'refund', -spent.amount, spent.script_hash, spent.id)
  on conflict (ref) where type = 'refund' do nothing;
  return jsonb_build_object('status', 'refunded', 'balance', credit_balance(spent.client_id));
end;
$$;

revoke execute on function public.credit_balance(text) from public, anon, authenticated;
revoke execute on function public.spend_analysis(text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.refund_analysis(bigint) from public, anon, authenticated;
grant execute on function public.credit_balance(text) to service_role;
grant execute on function public.spend_analysis(text, text, text, integer) to service_role;
grant execute on function public.refund_analysis(bigint) to service_role;

-- ---------- 결제 주문 (토스페이먼츠) ----------
-- 결제창을 띄우기 전에 서버가 주문(금액)을 먼저 저장하고, 승인할 때 돌아온 금액이 이 금액과 같은지 확인함
create table if not exists public.payment_orders (
  order_id text primary key,               -- 토스에 보내는 주문번호 (서버가 만든 UUID)
  client_id text not null,
  amount integer not null check (amount > 0),         -- 원
  credits integer not null check (credits > 0),
  order_name text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  payment_key text unique,                 -- 토스가 준 결제 키 (승인된 뒤)
  fail_code text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists payment_orders_client on public.payment_orders (client_id, created_at);
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from anon, authenticated;

create or replace function public.create_payment_order(p_client_id text, p_order_id text, p_amount integer, p_credits integer, p_order_name text)
returns jsonb language plpgsql set search_path = public as $$
begin
  insert into payment_orders (order_id, client_id, amount, credits, order_name)
  values (p_order_id, p_client_id, p_amount, p_credits, p_order_name);
  return jsonb_build_object('order_id', p_order_id, 'amount', p_amount, 'credits', p_credits, 'order_name', p_order_name);
end;
$$;

create or replace function public.get_payment_order(p_order_id text)
returns jsonb language sql stable set search_path = public as $$
  select to_jsonb(o) - 'payment_key' from payment_orders o where order_id = p_order_id;
$$;

-- 토스가 승인한 결제를 크레딧으로. 같은 주문을 두 번 불러도 한 번만 충전
create or replace function public.complete_payment_order(p_order_id text, p_payment_key text, p_amount integer)
returns jsonb language plpgsql set search_path = public as $$
declare
  o payment_orders;
begin
  select * into o from payment_orders where order_id = p_order_id for update;
  if not found then raise exception 'no order %', p_order_id; end if;
  if o.amount <> p_amount then raise exception 'amount mismatch for %', p_order_id; end if;
  if o.status = 'paid' then
    return jsonb_build_object('status', 'already', 'credits', o.credits, 'balance', credit_balance(o.client_id));
  end if;
  update payment_orders set status = 'paid', payment_key = p_payment_key, paid_at = now(), fail_code = null where order_id = p_order_id;
  insert into credit_ledger (client_id, type, amount, order_id) values (o.client_id, 'charge', o.credits, o.order_id);
  return jsonb_build_object('status', 'paid', 'credits', o.credits, 'balance', credit_balance(o.client_id));
end;
$$;

-- 승인 실패·취소. 이미 결제된 주문은 바꾸지 않음
create or replace function public.fail_payment_order(p_order_id text, p_code text)
returns void language sql set search_path = public as $$
  update payment_orders set status = 'failed', fail_code = left(p_code, 100) where order_id = p_order_id and status <> 'paid';
$$;

revoke execute on function public.create_payment_order(text, text, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.get_payment_order(text) from public, anon, authenticated;
revoke execute on function public.complete_payment_order(text, text, integer) from public, anon, authenticated;
revoke execute on function public.fail_payment_order(text, text) from public, anon, authenticated;
grant execute on function public.create_payment_order(text, text, integer, integer, text) to service_role;
grant execute on function public.get_payment_order(text) to service_role;
grant execute on function public.complete_payment_order(text, text, integer) to service_role;
grant execute on function public.fail_payment_order(text, text) to service_role;

-- 시험용 크레딧 넣기 (관리자가 SQL Editor에서 직접). 앱 화면에 보이는 '시험 ID'를 넣음:
-- insert into public.credit_ledger (client_id, type, amount) values ('<시험 ID>', 'grant', 1000);

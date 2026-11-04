# AI 분석 크레딧과 충전 결제 (staging 시험)

AI 분석 1회(배역 분석, 작품 분석, 장면 그림 설명)에 100크레딧(1,000원)을 차감한다. 크레딧은 토스페이먼츠 테스트 결제창으로 충전하거나 관리자가 SQL로 직접 넣는다.

- 원장: Supabase 표 `credit_ledger`. 잔액은 원장 금액의 합이다.
- 사람 구분: 로그인 대신 브라우저마다 만든 임시 ID(시험 ID). 브라우저 저장소를 지우면 새 ID가 생기고 크레딧은 옛 ID에 남는다.
- 켜지는 조건: 서버에 `SUPABASE_URL`과 비밀값 `SUPABASE_SERVICE_KEY`가 둘 다 있을 때만. 운영 배포(`cloudbuild.yaml`)는 비밀값을 `ANTHROPIC_API_KEY`로 덮어쓰므로 운영에서는 꺼져 있다.
- 충전 결제: 위 조건에 더해 `TOSS_CLIENT_KEY`(공개해도 되는 값)와 비밀값 `TOSS_SECRET_KEY`가 있어야 켜진다. 주문은 Supabase 표 `payment_orders`에 남는다.

## 충전 결제 흐름

1. "💳 1,000원 충전"을 누르면 서버가 주문(1,000원, 100크레딧)을 먼저 저장한다.
2. 토스 결제창이 뜬다. 테스트 키라 실제로 돈이 빠져나가지 않는다.
3. 결제를 마치면 토스가 앱 주소(`/?pay=success&paymentKey=…&orderId=…&amount=…`)로 돌려보낸다.
4. 서버는 돌아온 금액이 저장한 주문 금액과 같을 때만 토스 승인 API를 부르고 승인되면 원장에 `charge`(+100)를 남긴다. 같은 주문은 새로 고쳐도 한 번만 충전된다.
5. 취소하거나 실패하면 주문을 `failed`로 바꾸고 크레딧은 그대로 둔다.

## 차감 규칙

| 상황 | 결과 |
| --- | --- |
| 같은 대본(내용 해시)의 첫 분석 | 100크레딧 차감 |
| 같은 대본의 나머지 분석 (24시간 안) | 차감 없음 |
| 같은 `X-Request-Id`로 다시 온 요청 | 차감 없음 |
| 잔액 100 미만 | 402, Claude를 부르지 않음 |
| Claude 호출 실패 (거절, max_tokens, 네트워크) | 그 요청이 차감했으면 환불 |

일일 상한(`DAILY_ANALYSES`, `DAILY_ANALYSES_PER_CLIENT`)은 크레딧과 별개로 그대로 둔다.

## 준비 (한 번)

1. Supabase에서 staging용 프로젝트를 만든다.
2. SQL Editor에서 `supabase/credits.sql`을 실행한다. 다시 실행해도 된다.
3. Project Settings > API에서 Project URL과 `service_role` 키를 확인한다. `service_role` 키는 모든 데이터를 읽고 쓰는 키라서 채팅이나 코드, `.env`에 붙여 넣지 않고 Secret Manager에만 넣는다.
4. Google Cloud 콘솔 > Secret Manager에서 `supabase-service-key` 비밀값을 만들고 3의 키를 값으로 넣는다.
5. Cloud Run 실행 계정이 이 비밀값을 읽을 수 있게 한다.

```bash
gcloud secrets add-iam-policy-binding supabase-service-key --project=acting-practice --member="serviceAccount:acting-practice-run@acting-practice.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor
```

6. 토스페이먼츠 개발자센터(developers.tosspayments.com)에 가입하고 API 키 메뉴에서 **API 개별 연동 키**의 테스트 클라이언트 키(`test_ck_…`)와 테스트 시크릿 키(`test_sk_…`)를 확인한다. 결제위젯 연동 키(`test_gck_…`)가 아니다. 시크릿 키는 Secret Manager에 `toss-secret-key-staging` 비밀값으로만 넣는다. 토스 공식 샘플에 있는 문서용 키는 지금 토스가 거절하므로 쓸 수 없다.
7. 실행 계정이 이 비밀값도 읽을 수 있게 한다(5와 같은 명령에서 비밀값 이름만 바꾼다).
8. staging 배포 설정의 `--set-secrets`에 `SUPABASE_SERVICE_KEY=supabase-service-key:latest,TOSS_SECRET_KEY=toss-secret-key-staging:latest`를 더하고 `--set-env-vars`에 `SUPABASE_URL=<Project URL>,TOSS_CLIENT_KEY=<테스트 클라이언트 키>`를 더해 staging 배포를 한다.

## 시험하기

1. staging 주소를 열고 대본을 분석하면 배역 탭에 "남은 크레딧 0 · 시험 ID …"가 보인다. 크레딧이 없어 분석은 거절된다.
2. "💳 1,000원 충전"을 눌러 토스 테스트 결제창에서 결제한다. 돌아오면 위쪽에 "100크레딧을 충전했어요"가 나오고 남은 크레딧이 100이 된다. 결제 없이 크레딧만 넣으려면 📋 ID 복사로 시험 ID를 복사하고 SQL Editor에서 넣는다.

```sql
insert into public.credit_ledger (client_id, type, amount) values ('<시험 ID>', 'grant', 1000);
```

3. 화면을 새로 고치고 확인한다.
   - 대본을 분석하면 100이 빠진다.
   - 같은 대본으로 작품 분석이나 장면 그림을 하면 더 빠지지 않는다.
   - 다른 대본을 분석하면 다시 100이 빠진다.
   - 잔액이 100보다 적으면 "크레딧이 부족해요"가 나온다.
4. 원장과 주문을 본다.

```sql
select id, type, amount, left(script_hash, 8) as script, ref, created_at
from public.credit_ledger where client_id = '<시험 ID>' order by id;

select order_id, amount, credits, status, fail_code, created_at, paid_at
from public.payment_orders where client_id = '<시험 ID>' order by created_at;
```

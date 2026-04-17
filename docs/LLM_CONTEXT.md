# LLM 컨텍스트 전달 방식

> **문서 버전:** 2026-04-15
> **현재 아키텍처:** RAG-lite + Text-to-SQL (관리자 설정으로 모드 선택)
> **주요 구현 파일:** `backend/src/routes/chat.js`

---

## 1. 개요

본 챗봇은 **RAG-lite** 패턴으로 동작합니다.
LLM이 DB에 직접 접근하지 않고, **백엔드가 사용자 질문을 키워드/패턴 분석해 필요한 데이터를 미리 조회한 뒤 JSON 형태로 프롬프트에 주입**합니다.

| 방식 | 설명 | 현재 채택 |
|---|---|:---:|
| RAG-lite | 키워드 기반 사전 조회 → 프롬프트에 데이터 주입 | ✅ (기본값) |
| Text-to-SQL | LLM이 스키마 보고 SQL 생성 → 백엔드 실행 → 결과 다시 LLM에 전달 | ✅ (관리자 설정) |
| Tool Use | LLM이 OpenAI 호환 `tool_calls`로 함수 호출 | ❌ (모델 호환성 미보장) |
| Pure RAG | 벡터 DB로 유사도 검색 후 주입 | ❌ |

**모드 전환:** 관리자 설정(`Settings.vue` ⑥ LLM 모델 선택 섹션)의 라디오 버튼으로 선택.
설정값은 `admin_settings` 테이블의 `llm_mode` 키 (`rag_lite` | `text_to_sql`).

**근거:**
- `backend/src/routes/chat.js` — `router.post('/')` 핸들러가 `getSetting('llm_mode')` 값에 따라 `handleRagLite()` 또는 `handleTextToSql()` 분기
- `backend/src/db/init.js` — `DEFAULT_SETTINGS` 배열에 `['llm_mode', 'rag_lite', 'STRING', ...]` 시드

---

## 2. 전체 요청 흐름

```
[1] 프론트 (Chatbot.vue)
       │ POST /api/v1/chat { message, session_id }
       ▼
[2] 백엔드 (chat.js)
       │ buildContext(message) 실행 — SQLite 조회
       │ JSON.stringify(context) → 프롬프트에 삽입
       ▼
[3] LM Studio (127.0.0.1:1234)
       │ /v1/chat/completions (OpenAI 호환)
       │ Gemma-4 등 로컬 모델 추론
       ▼
[4] 백엔드 응답 처리
       │ content 또는 reasoning_content 추출
       │ llm_chat_logs 테이블에 기록
       ▼
[5] 프론트에 { answer, context } 반환
```

**근거:**
| 단계 | 코드 위치 |
|---|---|
| [1] 프론트 POST 호출 | `frontend/src/components/Chatbot.vue:33` — `api.post('/chat', { message: q, session_id: sessionId })` |
| [2] buildContext 실행 | `chat.js:61` — `const context = buildContext(message);` |
| [2] JSON 직렬화 + 프롬프트 | `chat.js:65-66` — `JSON.stringify(context, null, 2)` |
| [3] LM Studio 호출 | `chat.js:69` — `fetch(${baseURL}/v1/chat/completions, ...)` |
| [4] 로그 저장 | `chat.js:105-106` — `INSERT INTO llm_chat_logs ...` |
| [5] 응답 반환 | `chat.js:107` — `res.json({ answer, context })` |

---

## 3. 프롬프트 구조

LM Studio에 전달되는 메시지는 2개 role로 구성됩니다.

### system 메시지 (고정)

```
You are a BMS quality inspection assistant for EverNex smart factory.
Rules:
- Answer ONLY based on provided data. Never invent data.
- Provide evidence (vehicle IDs, values, timestamps).
- When suggesting actions, specify vehicle and action.
- Use Korean.
- Be concise and actionable.
```

**근거:** `chat.js:9-15` — `const SYSTEM_PROMPT = '...'` 상수 정의, `chat.js:75` — `{ role: 'system', content: SYSTEM_PROMPT }`

### user 메시지 (동적)

```
사용자 질문: {사용자 입력}

참고 데이터 (JSON):
{buildContext 결과를 JSON.stringify한 문자열}
```

**근거:** `chat.js:66` — `const userContent = '사용자 질문: ${message}\n\n참고 데이터 (JSON):\n${contextText}';`, `chat.js:76` — `{ role: 'user', content: userContent }`

---

## 4. buildContext() 데이터 명세

`chat.js:17-56`의 `buildContext(message)` 함수가 생성하는 JSON 구조.

| 필드 | 조건 | 건수 | 내용 | 코드 위치 |
|------|------|------|------|-----------|
| `stats.total` | **항상** | 숫자 1개 | 전체 차량 수 | `chat.js:18` — `SELECT COUNT(*) AS c FROM cars` |
| `stats.byStatus` | **항상** | 상태별 그룹 | `[{ status, count }, ...]` | `chat.js:19` — `GROUP BY current_status` |
| `openAlerts` | **항상** | **최대 10건** | 미해결 경보 (`current_status != 'RESOLVED'`) | `chat.js:20` — `LIMIT 10` |
| `filteredCars` | 키워드 매칭 시 | **최대 20건** | 상태 키워드에 해당하는 차량 목록 | `chat.js:32-36` — `hit = keywordToStatus.find(...)`, `LIMIT 20` |
| `selectedVehicle` | `VH-YYYYMMDD-NNNN` 패턴 매칭 시 | 1건 | 차량 + 최신 배터리 측정값 | `chat.js:38-47` — 정규식 + 조회 |
| `statusLabels` | **항상** | 고정 객체 | 상태코드 → 한글명 매핑 | `chat.js:54` — `statusLabels: STATUS_LABELS_KR` |

**반환 객체 근거:** `chat.js:49-55` — `return { stats, openAlerts, filteredCars, selectedVehicle, statusLabels }`

### JSON 예시

```json
{
  "stats": {
    "total": 1200,
    "byStatus": [
      { "status": "BATTERY_INSPECTION", "count": 42 },
      { "status": "SHIPMENT_WAITING", "count": 156 }
    ]
  },
  "openAlerts": [
    { "car_id": "VH-20260415-0023", "alert_type": "SOC_ABNORMAL",
      "alert_message": "...", "severity": "HIGH",
      "occurred_at": "2026-04-15T09:12:34", "current_status": "OPEN" }
  ],
  "filteredCars": [
    { "car_id": "VH-20260415-0152", "model_name": "노바 X5",
      "current_status": "BATTERY_INSPECTION", "destination_country": "미국" }
  ],
  "selectedVehicle": null,
  "statusLabels": { "ARRIVAL": "입고", "BATTERY_INSPECTION": "배터리 검사중", ... }
}
```

---

## 5. 키워드 매칭 테이블

사용자 메시지에 아래 키워드가 포함되면 해당 상태의 차량을 조회해 `filteredCars`에 담습니다.

| 키워드 | 매칭 상태 (STATUSES) | 코드 위치 |
|--------|----------------------|-----------|
| `검사중` | BATTERY_INSPECTION, CELL_INSPECTION, RE_INSPECTION | `chat.js:25` |
| `출고대기` | SHIPMENT_WAITING | `chat.js:26` |
| `출고완료` | SHIPMENT_COMPLETE | `chat.js:27` |
| `이상` | ANOMALY_DETECTED, QA_MAINTENANCE | `chat.js:28` |
| `경고` | ANOMALY_DETECTED, QA_MAINTENANCE | `chat.js:29` |
| `입고` | ARRIVAL | `chat.js:30` |

**테이블 정의 근거:** `chat.js:24-31` — `const keywordToStatus = [...]`

SQL (`chat.js:35`):
```sql
SELECT car_id, model_name, current_status, destination_country
FROM cars
WHERE current_status IN (?)
ORDER BY updated_at DESC
LIMIT 20
```

**첫 번째로 매칭된 키워드만 사용**됩니다. 여러 키워드가 포함돼도 우선순위는 위 테이블 순서.
**근거:** `chat.js:32` — `const hit = keywordToStatus.find(([kw]) => message && message.includes(kw));` → `.find()`는 첫 번째 매칭에서 종료.

---

## 6. 차량 ID 직접 참조

사용자 메시지에 `VH-YYYYMMDD-NNNN` 형식의 차량 ID가 포함되면, 해당 차량의 상세 데이터를 `selectedVehicle`에 담습니다.

| 항목 | 내용 | 코드 위치 |
|---|---|---|
| 정규식 | `/VH-\d{8}-\d{4}/i` | `chat.js:38` |
| 차량 조회 | `SELECT * FROM cars WHERE car_id=?` | `chat.js:41` |
| 배터리 조회 | `SELECT * FROM batteries WHERE car_id=?` | `chat.js:43` |
| 최신 측정값 조회 | `SELECT * FROM battery_measurements WHERE battery_id=? ORDER BY inspected_at DESC LIMIT 1` | `chat.js:44` |
| 응답 구조 할당 | `{ car, measurement }` | `chat.js:45` |

---

## 7. LM Studio 호출 파라미터

OpenAI 호환 `/v1/chat/completions` 엔드포인트 호출 (`chat.js:69-81`).

| 파라미터 | 값 | 비고 | 코드 위치 |
|---|---|---|---|
| `baseURL` | `process.env.LLM_BASE_URL` 또는 `http://127.0.0.1:1234` | LM Studio 기본 주소 | `chat.js:62` |
| `model` | `getSetting('llm_model', process.env.LLM_MODEL \|\| 'local-model')` | **관리자 설정에서 변경 가능** | `chat.js:63`, `services/settings.js:3-10` (`getSetting`) |
| `temperature` | `0.2` | 일관된 답변 유도 (낮은 값) | `chat.js:78` |
| `max_tokens` | `3000` | thinking 모델 reasoning 공간 확보 | `chat.js:79` |

**엔드포인트 호출 근거:** `chat.js:69` — `await fetch(${baseURL}/v1/chat/completions, { method: 'POST', ... })`

---

## 8. 응답 처리

LM Studio 응답에서 답변을 추출하는 우선순위.

| 순서 | 조건 | 동작 | 코드 위치 |
|---|---|---|---|
| 1 | `choices[0].message.content` 값 존재 | 해당 문자열을 `answer`로 사용 | `chat.js:91-93` |
| 2 | content가 빈 문자열 + `reasoning_content` 존재 | `reasoning_content`를 fallback 사용 | `chat.js:94-96` |
| 3 | 둘 다 비고 `finish_reason === 'length'` | 502 "토큰 한도 도달" 에러 | `chat.js:98-101` |
| 4 | 그 외 | 502 "빈 응답" 에러 | `chat.js:102` |

**Gemma-4, DeepSeek-R1** 같은 thinking 모델은 `<think>` 추론 토큰에 max_tokens를 다 써버려 `content`가 비는 경우가 있어 fallback 처리가 필요합니다.
**근거:** `chat.js:92` 주석 — `// Gemma-4 등 thinking 모델은 content가 비고 reasoning_content만 오는 경우 있음`

---

## 9. 로깅

모든 대화는 `llm_chat_logs` 테이블에 저장됩니다.

**스키마 정의 근거:** `backend/src/db/schema.js:136-144`
```sql
CREATE TABLE llm_chat_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  session_id TEXT,
  user_message TEXT,
  assistant_message TEXT,
  context_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**INSERT 근거:** `chat.js:105-106`
```js
db.prepare('INSERT INTO llm_chat_logs (user_id,session_id,user_message,assistant_message,context_data,created_at) VALUES (?,?,?,?,?,?)')
  .run(req.user.uid, session_id || null, message, answer, JSON.stringify(context).slice(0, 4000), nowISO());
```

| 필드 | 세부사항 | 코드 위치 |
|---|---|---|
| `session_id` | 프론트에서 난수 생성 (대화 세션 묶음용) | `Chatbot.vue:13` — `Math.random().toString(36).slice(2)` |
| `context_data` | buildContext 결과를 **최대 4000자 truncate** | `chat.js:106` — `JSON.stringify(context).slice(0, 4000)` |
| `user_id` | JWT 인증된 사용자 UID | `chat.js:106` — `req.user.uid` (`authRequired` 미들웨어가 주입) |

---

## 10. 에러 메시지 분류

백엔드가 상황별로 서로 다른 에러 문구를 반환합니다.

| 상황 | HTTP | 에러 문구 | 코드 위치 |
|---|---|---|---|
| LM Studio 응답 200이 아님 + "No models loaded" | 502 | "로드된 모델이 없습니다..." | `chat.js:86` |
| LM Studio 응답 200이 아님 + "model not found" | 502 | "요청한 모델({model})을 찾을 수 없습니다..." | `chat.js:87` |
| `content` + `reasoning_content` 모두 비고 `finish_reason='length'` | 502 | "응답이 토큰 한도에 도달했습니다..." | `chat.js:99-100` |
| content가 빈 응답 (finish_reason이 length 아님) | 502 | "LLM이 빈 응답을 반환했습니다." | `chat.js:102` |
| ECONNREFUSED / fetch failed / ENOTFOUND | 502 | "LM Studio({baseURL})에 연결 실패..." | `chat.js:111` |
| timeout / aborted | 502 | "LLM 응답 대기 시간 초과 (cold start)..." | `chat.js:112` |
| 기타 catch | 502 | "LLM 서버에 연결할 수 없습니다..." | `chat.js:110, 113` |

**프론트 측 detail 보존 근거:**
- `frontend/src/composables/api.js:15-20` — `err.detail = data.detail; err.status = r.status; throw err;`
- `frontend/src/components/Chatbot.vue:35-36` — `catch (e) { history.value.push({ ..., detail: e.detail, error: true }); }`
- `Chatbot.vue:120-122` — 에러 메시지 하단에 `m.detail` 원문을 monospace로 표시

---

## 11. RAG-lite 방식의 한계 (Text-to-SQL 모드로 해소)

아래 한계는 **RAG-lite 모드에서만** 발생합니다. Text-to-SQL 모드로 전환하면 대부분 해결됩니다 (섹션 13 참조).

| # | 한계 | 예시 질문 | 근거 (코드 위치) | Text-to-SQL로 해결? |
|---|------|-----------|-----------|:---:|
| 1 | 경보는 항상 미해결만 | "해결된 경보 보여줘" → 미해결 10건만 감 | `WHERE a.current_status!='RESOLVED'` 하드코딩 | ✅ |
| 2 | 날짜 범위 조회 불가 | "어제 이상난 차량" → 데이터 없음 | `buildContext()` 내 어떤 쿼리도 `created_at`/`occurred_at`으로 필터하지 않음 | ✅ |
| 3 | 공장/모델/국가 필터 없음 | "청림공장 벡터 E6만" → 키워드 매칭 안됨 | 키워드 테이블이 상태만 다룸 | ✅ |
| 4 | 집계 질문 불가 | "청림공장 평균 SOC" → 원시 데이터만 있고 계산 불가 | `buildContext`가 반환하는 집계는 `stats.byStatus`뿐. AVG/SUM 조회 없음 | ✅ |
| 5 | 키워드 매칭 시에만 차량 목록 | 상태 키워드 없는 질문은 통계만 전달 | `if (hit) { ... }` 조건부 | ✅ |
| 6 | 프롬프트 토큰 고정 | 질문과 무관하게 경보 10건 + 상태 라벨 항상 포함 | LIMIT 10 고정, `statusLabels` 항상 포함 | ✅ |

**Text-to-SQL의 단점:** LLM 호출 횟수 2배 (SQL 생성 + 답변 생성), 응답 지연 증가, 모델이 틀린 SQL 생성 가능성.

---

## 12. 관련 코드 위치

| 항목 | 파일 |
|------|------|
| 라우터 진입점 (모드 분기) | `backend/src/routes/chat.js` → `router.post('/')` |
| RAG-lite 핸들러 | `chat.js` → `handleRagLite()`, `buildContext()` |
| Text-to-SQL 핸들러 | `chat.js` → `handleTextToSql()` |
| SQL 검증 | `chat.js` → `validateSql()`, `injectLimit()`, `extractJson()`, `ALLOWED_TABLES` |
| LLM 호출 헬퍼 | `chat.js` → `callLlm()` |
| 시스템 프롬프트 | `chat.js` → `SYSTEM_PROMPT`, `SQL_SYSTEM_PROMPT`, `SCHEMA_PROMPT` |
| 상태 정의 | `backend/src/services/constants.js` → `STATUSES`, `STATUS_LABELS_KR` |
| 대화 로그 스키마 | `backend/src/db/schema.js:136` → `llm_chat_logs` |
| 관리자 설정 시드 | `backend/src/db/init.js` → `DEFAULT_SETTINGS` (llm_model, llm_mode) |
| 설정 읽기 | `backend/src/services/settings.js` → `getSetting()` |
| 관리자 UI | `frontend/src/views/Settings.vue` → ⑥ LLM 모델 선택 섹션 |
| 프론트 챗봇 UI | `frontend/src/components/Chatbot.vue` |
| 에러 detail 전달 | `frontend/src/composables/api.js` → `req()` |

---

## 13. Text-to-SQL 모드 동작

관리자 설정에서 `llm_mode = 'text_to_sql'`로 변경하면 활성화됩니다.

### 13.1 2단계 호출 흐름

```
[1] 사용자 질문 (예: "청림공장 벡터 E6 평균 SOC")
       │
       ▼
[2] 1차 LLM 호출 — SQL 생성
    system: SQL_SYSTEM_PROMPT (JSON만 반환하도록 강제)
    user:   SCHEMA_PROMPT + 사용자 질문
    응답:   {"sql": "SELECT AVG(bm.soc) ...", "reasoning": "..."}
       │
       ▼
[3] 백엔드 검증·실행
    - extractJson() — markdown fence·외곽 텍스트 제거 후 JSON 파싱
    - validateSql() — SELECT 시작, 화이트리스트 테이블, 세미콜론 다중 구문 차단
    - injectLimit() — 기존 LIMIT 없으면 LIMIT 100 자동 주입
    - db.prepare(sql).all() 실행 (better-sqlite3는 SELECT에 대해 read-only)
       │
       ▼
[4] 2차 LLM 호출 — 자연어 답변 생성
    system: SYSTEM_PROMPT (일반 답변용)
    user:   질문 + 실행한 SQL + 결과(JSON) → 한국어로 답변하게 지시
       │
       ▼
[5] { answer, context: {mode, sql, reasoning, rows_count, rows}, mode: 'text_to_sql' }
```

**근거:**
- `chat.js` — `handleTextToSql()` 함수가 위 5단계를 순차 실행
- `chat.js` — `callLlm({ ... })` 헬퍼가 1차·2차 호출 모두에서 재사용

### 13.2 SQL 검증 규칙

| 규칙 | 실패 시 에러 | 코드 |
|---|---|---|
| SELECT로 시작 (주석 제거 후) | "SELECT 쿼리만 허용됩니다" | `validateSql()` 정규식 `^\s*SELECT\b` |
| 세미콜론 다중 구문 금지 | "다중 구문은 허용되지 않습니다" | `validateSql()` — 세미콜론 위치 검사 |
| FROM/JOIN 뒤 테이블명이 화이트리스트 | "허용되지 않는 테이블: {name}" | `ALLOWED_TABLES` 세트 |
| SELECT인데 실행 실패 | "SQL 실행 실패: {msg}" | `handleTextToSql()` try/catch |

### 13.3 화이트리스트 테이블

민감 테이블(`users`, `admin_settings`) 은 **제외**.

```
cars, batteries, battery_measurements, alerts,
factories, countries, battery_cells, battery_cell_measurements,
car_status_histories, alert_status_histories,
process_step_histories, inspection_results
```

**근거:** `chat.js` → `const ALLOWED_TABLES = new Set([...])` 정의

### 13.4 프롬프트 크기

- **SCHEMA_PROMPT**: 12개 테이블의 핵심 컬럼 + 타입 + 한글 설명 + 상태 라벨 매핑 (약 1,500 토큰)
- **1차 호출 입력**: SCHEMA_PROMPT + 질문 = 약 1,500~1,600 토큰
- **2차 호출 입력**: 질문 + SQL + 결과 JSON (최대 100건 × 평균 200 토큰 = ~20,000 토큰 가능)

최대 행이 많은 쿼리는 2차 호출 입력이 커서 응답이 느려지거나 토큰 한도를 넘을 수 있음.

### 13.5 로깅

`llm_chat_logs.context_data`에 다음 형태로 저장:
```json
{ "mode": "text_to_sql",
  "sql": "SELECT ... LIMIT 100",
  "reasoning": "...",
  "rows_count": 42,
  "rows": [ ...최대 50건... ] }
```

**근거:** `chat.js` → `handleTextToSql()` 내 `const context = { mode, sql, ... }` 및 `INSERT INTO llm_chat_logs`.

### 13.6 Text-to-SQL 모드 에러 패턴

| 상황 | 에러 문구 | 코드 위치 |
|---|---|---|
| LLM 응답에서 JSON 추출 실패 | "LLM이 생성한 SQL JSON을 파싱할 수 없습니다: ..." | `handleTextToSql()` extractJson catch |
| JSON에 `sql` 필드 없음 | "LLM 응답에 sql 필드가 없습니다" | `handleTextToSql()` |
| 검증 실패 (SELECT 아님) | "SQL 검증 실패: SELECT 쿼리만 허용됩니다" | `validateSql()` |
| 검증 실패 (비허용 테이블) | "SQL 검증 실패: 허용되지 않는 테이블: {name}" | `validateSql()` |
| SQL 실행 예외 | "SQL 실행 실패: {sqlite 에러 메시지}" | `handleTextToSql()` db.prepare catch |

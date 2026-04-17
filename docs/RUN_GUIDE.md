# 실행 가이드 (로컬 프로토타입)

## 사전 준비
- Node.js 18+ 권장 (fetch, ESM 지원)
- macOS / Linux / Windows 모두 OK
- (선택) LM Studio — 챗봇 LLM 응답 용. 없어도 대시보드는 정상 동작합니다.

## 1. 백엔드 실행

```bash
cd 04_BMS_SF/backend
cp .env.example .env     # 필요 시 편집
npm install
npm run dev              # 또는 npm start
```

- 최초 실행 시 `backend/database/bms.db` SQLite 파일이 자동 생성됩니다.
- 사용자, 공장, 국가, 설정, 샘플 차량이 자동 시드됩니다.
- 시뮬레이션 엔진이 바로 시작되어 매 10초(기본) 새로운 차량을 생성하고 검사 파이프라인을 진행합니다.
- API: `http://localhost:3000/api/v1`
- 헬스 체크: `http://localhost:3000/health`

## 2. 프론트엔드 실행

```bash
cd 04_BMS_SF/frontend
cp .env.example .env
npm install
npm run dev
```

- 개발 서버: `http://localhost:5173`
- 브라우저 접속 → 로그인 화면 → 테스트 계정 중 하나로 로그인

## 3. LM Studio (선택)

1. LM Studio 설치 후 임의의 chat-tuned 모델 로드
2. 좌측 Local Server → **Start Server**
3. 기본 URL `http://127.0.0.1:1234` (변경 시 `backend/.env`의 `LLM_BASE_URL` 수정)
4. 프론트 오른쪽 하단 캐릭터 버튼을 눌러 대화창 열기

LM Studio가 꺼져 있으면 챗봇은 다음과 같이 안내합니다:
> "LLM 서버에 연결할 수 없습니다. LM Studio가 실행 중인지 확인해주세요."

## 4. 환경 변수

### backend/.env
```
PORT=3000
JWT_SECRET=bms-sf-secret-change-in-production
DB_PATH=./database/bms.db
LLM_BASE_URL=http://127.0.0.1:1234
LLM_MODEL=local-model
```

### frontend/.env
```
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

## 5. 주요 페이지

| URL | 설명 |
|-----|------|
| `/login` | 로그인 |
| `/` | 대시보드 (5초 폴링) |
| `/vehicles` | 차량 목록 / 필터 / 검색 |
| `/vehicles/:carId` | 차량 상세 — 게이지, 셀 히트맵, 타임라인, 경보, 알람 해결 |
| `/alerts` | 경보 로그 / 일괄 확인·해결 |
| `/settings` | 관리자 설정 (admin 전용) |

## 6. 데이터 초기화

```bash
rm 04_BMS_SF/backend/database/bms.db
# 백엔드를 재시작하면 재시드됩니다.
```

## 7. MySQL 마이그레이션

`04_BMS_SF/sql/schema.sql` + `seed.sql`을 프로덕션 MySQL에 적용하세요. SQLite와 컬럼/제약은 호환 설계되어 있습니다 (타입만 DECIMAL → REAL 등 자동 매핑됨).

## 자주 겪는 문제

- **`better-sqlite3` 빌드 실패**: Node 버전 확인(18+), Xcode CLT(macOS) 설치 `xcode-select --install`
- **CORS 오류**: 프론트 `.env`의 API URL이 백엔드 주소와 일치하는지 확인
- **로그인 실패**: DB 파일을 삭제하고 재시작하면 기본 계정이 재시드됩니다

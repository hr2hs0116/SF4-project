# feat/project-setup — Spring Boot 초기 세팅

## 포함 파일

**백엔드**
- `backend/pom.xml` — Maven 의존성 (Spring Boot, JdbcTemplate, SQLite, JWT 등)
- `backend/src/main/resources/` — application.yml 등 설정
- `backend/src/main/java/com/evernex/bms/BmsApplication.java` — 진입점
- `backend/src/main/java/com/evernex/bms/config/WebConfig.java` — CORS / 필터 등록
- `backend/src/main/java/com/evernex/bms/controller/HealthController.java` — `/health`
- `backend/src/main/java/com/evernex/bms/db/TimeUtil.java` — ISO 시간 유틸
- `backend/src/main/java/com/evernex/bms/domain/Constants.java` — 공용 상수
- `backend/src/main/java/com/evernex/bms/security/ApiException.java` — 사용자 정의 예외
- `backend/src/main/java/com/evernex/bms/security/GlobalExceptionHandler.java` — @ControllerAdvice

**프론트**
- `frontend/vite.config.js`, `package.json`, `tailwind.config.js`, `postcss.config.js`, `index.html` — 빌드 설정
- `frontend/src/App.vue`, `main.js`, `router/index.js`
- `frontend/src/layouts/AppLayout.vue`
- `frontend/src/composables/api.js` — 전역 HTTP 래퍼 (JWT 헤더 자동)

## 의존 브랜치
없음 — **가장 먼저 머지**

## 적용
같은 상대 경로로 복사 후 커밋.

## 커밋 메시지 예시
```
chore(setup): Spring Boot + Vue 3 프로젝트 스캐폴딩

- 백엔드 pom.xml + BmsApplication + WebConfig + Global 예외
- 프론트 vite + router + layout + api 래퍼
```

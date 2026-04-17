import { Router } from 'express';
import { db, nowISO } from '../db/index.js';
import { authAndScope, authRequired } from '../middleware/auth.js';
import { STATUSES } from '../services/constants.js';
import { getSetting } from '../services/settings.js';
import { factoryScopeClause } from '../db/factoryScope.js';

const router = Router();

const SYSTEM_PROMPT_KO = `You are a BMS quality inspection assistant for EverNex smart factory.
Rules:
- Answer ONLY based on provided data. Never invent data.
- Provide evidence (vehicle IDs, values, timestamps).
- When suggesting actions, specify vehicle and action.
- Use Korean.
- Be concise and actionable.`;

const SYSTEM_PROMPT_EN = `You are a BMS quality inspection assistant for EverNex smart factory.
Rules:
- Answer ONLY based on provided data. Never invent data.
- Provide evidence (vehicle IDs, values, timestamps).
- When suggesting actions, specify vehicle and action.
- Respond in English only. Translate any Korean factory/model/country names into their English equivalents (e.g., 청림공장 → Cheongrim Plant, 노바 X5 → Nova X5, 에버랜드 → EverLand, 노바 → Nova, 벡터 → Vector).
- Be concise and actionable.`;

function systemPromptForLocale(locale) {
  return locale === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_KO;
}

const SQL_SYSTEM_PROMPT = `You are a SQLite SQL generator for a BMS (Battery Management System) factory database.
Your job: convert the user's Korean question into a single SELECT query.

STRICT RULES:
- Return ONLY a JSON object: {"sql": "<SELECT ...>", "reasoning": "<short why>"}
- SQL must be a single SELECT statement. No INSERT/UPDATE/DELETE/DROP.
- Use only the tables and columns shown in the schema below.
- Prefer explicit JOINs over subqueries when possible.
- Add LIMIT 100 if the query could return many rows.
- Do NOT include semicolons at the end.
- Do NOT wrap SQL in markdown code blocks.`;

const SCHEMA_PROMPT = `# Schema (SQLite)
cars(car_id PK, model_name, factory_id FK, destination_country, production_date, current_status, created_at, updated_at)
factories(factory_id PK, factory_name, region, country, brand, is_active)
batteries(battery_id PK, car_id FK, battery_serial_number, manufacture_date)
battery_measurements(measurement_id PK, battery_id FK, soc, soh, sop, avg_voltage, avg_temperature, inspected_at)
battery_cells(cell_id PK, battery_id FK, cell_number)
battery_cell_measurements(cell_measurement_id PK, cell_id FK, cell_temperature, cell_voltage, measured_at)
alerts(alert_id PK, car_id FK, alert_type, alert_message, severity, current_status, occurred_at, resolved_at)
countries(country_id PK, country_name, country_code, is_allowed)
car_status_histories(car_status_history_id PK, car_id, status, changed_at, changed_by_user_id)
alert_status_histories(history_id PK, alert_id, status, changed_at, changed_by_user_id)
process_step_histories(process_history_id PK, car_id, step_name, step_status, started_at, ended_at)
inspection_results(result_id PK, car_id, status, performance_status, safety_status, finalized_at)

# Enum values (use English UPPERCASE only in WHERE)
cars.current_status: ARRIVAL(입고) | BATTERY_INSPECTION(배터리검사중) | CELL_INSPECTION(셀검사중) | ANOMALY_DETECTED(이상) | QA_MAINTENANCE(정비중) | RE_INSPECTION_WAITING(재검사대기) | RE_INSPECTION(재검사중) | BATTERY_QC_COMPLETE(QC완료) | SHIPMENT_WAITING(출고대기) | SHIPMENT_COMPLETE(출고완료)
alerts.severity: LOW | MEDIUM | HIGH | CRITICAL
alerts.current_status: OPEN | ACKNOWLEDGED | RESOLVED

# Notes
- car_id format: VH-YYYYMMDD-NNNN
- factory_name (Korean): 청림공장, 은하공장, 백운공장, 단풍공장, 태양공장, 한빛공장
- model_name (Korean): 노바 X5, 벡터 E6, 볼트 S, etc.
- NEVER use Korean labels in WHERE — only ENGLISH UPPERCASE codes for status/severity.
- Date functions: datetime('now', '-1 hour'), date('now')
`;

const ALLOWED_TABLES = new Set([
  'cars', 'batteries', 'battery_measurements', 'alerts',
  'factories', 'countries', 'battery_cells', 'battery_cell_measurements',
  'car_status_histories', 'alert_status_histories',
  'process_step_histories', 'inspection_results',
]);

// 차량 권한이 적용돼야 하는 테이블 (cars JOIN 또는 factory_id 필터 필수).
// factories/countries는 권한 무관 메타 데이터.
const SCOPED_TABLES = new Set([
  'cars', 'alerts', 'batteries', 'battery_measurements',
  'battery_cells', 'battery_cell_measurements',
  'car_status_histories', 'alert_status_histories',
  'process_step_histories', 'inspection_results',
]);

function validateSql(sql, allowedFactoryIds, isAdminScope) {
  const clean = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^\s*SELECT\b/i.test(clean)) {
    throw new Error('SELECT 쿼리만 허용됩니다');
  }
  const semiIdx = clean.indexOf(';');
  if (semiIdx !== -1 && semiIdx < clean.length - 1) {
    throw new Error('다중 구문은 허용되지 않습니다');
  }
  const tables = [...clean.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w]*)/gi)].map(m => m[1].toLowerCase());
  for (const t of tables) {
    if (!ALLOWED_TABLES.has(t)) {
      throw new Error(`허용되지 않는 테이블: ${t}`);
    }
  }

  // 공장 권한 강제 (admin은 통과). 차량 관련 테이블 참조 시 cars JOIN + factory_id IN (...) 필수.
  // batteries/battery_measurements 등 child 테이블만 써도 권한 검증되도록 SCOPED_TABLES 전체 검사.
  if (isAdminScope) return;
  const touchesScopedTable = tables.some(t => SCOPED_TABLES.has(t));
  if (!touchesScopedTable) return;

  // cars 테이블이 직접 포함돼야 함 (child 테이블만 쓰면서 권한 우회 차단)
  if (!tables.includes('cars')) {
    throw new Error('차량 관련 조회는 cars 테이블을 JOIN해야 합니다 (권한 검증용)');
  }

  const inMatch = clean.match(/factory_id\s+IN\s*\(([^)]+)\)/i);
  if (!inMatch) {
    throw new Error('factory_id 필터 누락 — 차량/배터리/경보 관련 조회 시 cars.factory_id IN (...) 필수');
  }
  const requestedIds = inMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
  const allowedSet = new Set(allowedFactoryIds);
  const outOfScope = requestedIds.filter(id => !allowedSet.has(id));
  if (outOfScope.length > 0) {
    throw new Error(`허용되지 않은 공장: ${outOfScope.join(',')}`);
  }
}

function injectLimit(sql, defaultLimit = 100) {
  const stripped = sql.replace(/;\s*$/, '').trim();
  if (/\bLIMIT\s+\d+/i.test(stripped)) return stripped;
  return `${stripped} LIMIT ${defaultLimit}`;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('JSON 객체를 찾을 수 없습니다');
  return JSON.parse(objMatch[0]);
}

function buildContext(message, allowedFactoryIds) {
  const fScope = factoryScopeClause(allowedFactoryIds, 'factory_id');
  const aScope = factoryScopeClause(allowedFactoryIds, 'c.factory_id');

  // 관리자 설정에서 한도 읽기 (잘못된 값이면 기본값으로 폴백)
  const alertsLimit = Math.max(1, Math.min(500, parseInt(getSetting('llm_context_alerts', 8), 10) || 8));
  const carsLimit = Math.max(1, Math.min(500, parseInt(getSetting('llm_context_cars', 20), 10) || 20));
  const msgMax = Math.max(0, Math.min(2000, parseInt(getSetting('llm_alert_msg_max', 80), 10) || 0));

  const total = db.prepare(`SELECT COUNT(*) AS c FROM cars WHERE 1=1${fScope.sql}`).get(...fScope.params).c;
  const statusRows = db.prepare(`SELECT current_status AS status, COUNT(*) AS count FROM cars WHERE 1=1${fScope.sql} GROUP BY current_status`).all(...fScope.params);
  // 경보 메시지가 길면 잘라서 토큰 절약 (msgMax=0이면 원본 그대로)
  const msgExpr = msgMax > 0 ? `substr(a.alert_message, 1, ${msgMax})` : 'a.alert_message';
  const openAlerts = db.prepare(`SELECT a.alert_id, a.car_id, a.alert_type, ${msgExpr} AS alert_message, a.severity, a.occurred_at, a.current_status, c.model_name FROM alerts a LEFT JOIN cars c ON c.car_id=a.car_id WHERE a.current_status!='RESOLVED'${aScope.sql} ORDER BY a.occurred_at DESC LIMIT ${alertsLimit}`).all(...aScope.params);

  let filteredCars = [];
  const keywordToStatus = [
    ['검사중', [STATUSES.BATTERY_INSPECTION, STATUSES.CELL_INSPECTION, STATUSES.RE_INSPECTION]],
    ['출고대기', [STATUSES.SHIPMENT_WAITING]],
    ['출고완료', [STATUSES.SHIPMENT_COMPLETE]],
    ['이상', [STATUSES.ANOMALY_DETECTED, STATUSES.QA_MAINTENANCE]],
    ['경고', [STATUSES.ANOMALY_DETECTED, STATUSES.QA_MAINTENANCE]],
    ['입고', [STATUSES.ARRIVAL]],
  ];
  const hit = keywordToStatus.find(([kw]) => message && message.includes(kw));
  if (hit && (allowedFactoryIds?.length || 0) > 0) {
    const placeholders = hit[1].map(() => '?').join(',');
    filteredCars = db.prepare(`SELECT car_id, model_name, current_status, destination_country FROM cars WHERE current_status IN (${placeholders})${fScope.sql} ORDER BY updated_at DESC LIMIT ${carsLimit}`).all(...hit[1], ...fScope.params);
  }
  const carIdMatch = (message || '').match(/VH-\d{8}-\d{4}/i);
  let selectedVehicle = null;
  if (carIdMatch) {
    const car = db.prepare(`SELECT * FROM cars WHERE car_id=?${fScope.sql}`).get(carIdMatch[0].toUpperCase(), ...fScope.params);
    if (car) {
      const battery = db.prepare('SELECT * FROM batteries WHERE car_id=?').get(car.car_id);
      const measurement = battery ? db.prepare('SELECT * FROM battery_measurements WHERE battery_id=? ORDER BY inspected_at DESC LIMIT 1').get(battery.battery_id) : null;
      selectedVehicle = { car, measurement };
    }
  }

  return {
    stats: { total, byStatus: statusRows },
    openAlerts: openAlerts.map(a => ({ car_id: a.car_id, type: a.alert_type, msg: a.alert_message, sev: a.severity, at: a.occurred_at })),
    filteredCars,
    selectedVehicle,
  };
}

async function callLlm({ baseURL, model, systemPrompt, userContent, maxTokens }) {
  // maxTokens가 명시적으로 안 넘어오면 관리자 설정값 사용 (기본 3000)
  const effectiveMax = Number.isInteger(maxTokens) && maxTokens > 0
    ? maxTokens
    : Math.max(100, Math.min(32000, parseInt(getSetting('llm_max_tokens', 3000), 10) || 3000));
  const r = await fetch(`${baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: effectiveMax,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    let hint = 'LLM 서버 응답 오류';
    if (/No models loaded/i.test(text)) hint = 'LM Studio에 로드된 모델이 없습니다. 모델을 로드해주세요. (유휴 시 자동 언로드 되었을 수 있음)';
    else if (/model.*not found/i.test(text)) hint = `요청한 모델(${model})을 찾을 수 없습니다. 관리자 설정에서 모델명을 확인하세요.`;
    else if (/n_keep|n_ctx|context length|context_length|too many tokens|exceeds.*context/i.test(text)) {
      const m = text.match(/n_keep:\s*(\d+).*?n_ctx:\s*(\d+)/i);
      const detail = m ? ` (입력 ${m[1]} 토큰 > 모델 한도 ${m[2]} 토큰)` : '';
      hint = `LLM 모델의 컨텍스트 길이가 부족합니다${detail}. LM Studio에서 모델을 더 큰 컨텍스트(권장 8192 이상)로 다시 로드하세요. Text-to-SQL 모드는 약 5000 토큰의 스키마를 보내므로 최소 8K 컨텍스트가 필요합니다.`;
    }
    const err = new Error(hint);
    err.detail = text.slice(0, 400);
    err.status = 502;
    throw err;
  }
  const data = await r.json();
  const msg = data?.choices?.[0]?.message || {};
  let answer = msg.content;
  if (!answer || !answer.trim()) {
    if (msg.reasoning_content && msg.reasoning_content.trim()) {
      answer = msg.reasoning_content;
    } else {
      const finish = data?.choices?.[0]?.finish_reason;
      if (finish === 'length') {
        const err = new Error('응답이 토큰 한도에 도달했습니다. (thinking 모델의 추론 토큰이 응답을 잠식한 경우일 수 있음)');
        err.detail = `finish_reason=length, usage=${JSON.stringify(data?.usage || {})}`;
        err.status = 502;
        throw err;
      }
      const err = new Error('LLM이 빈 응답을 반환했습니다.');
      err.detail = `finish_reason=${finish}`;
      err.status = 502;
      throw err;
    }
  }
  return { answer, raw: data };
}

async function handleRagLite(req, res, { baseURL, model }) {
  const { message, session_id, locale } = req.body;
  const context = buildContext(message, req.allowedFactoryIds);
  const contextText = JSON.stringify(context, null, 2);
  const qLabel = locale === 'en' ? 'User question' : '사용자 질문';
  const dLabel = locale === 'en' ? 'Reference data (JSON)' : '참고 데이터 (JSON)';
  const userContent = `${qLabel}: ${message}\n\n${dLabel}:\n${contextText}`;

  const { answer } = await callLlm({ baseURL, model, systemPrompt: systemPromptForLocale(locale), userContent });
  db.prepare('INSERT INTO llm_chat_logs (user_id,session_id,user_message,assistant_message,context_data,created_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.uid, session_id || null, message, answer, JSON.stringify({ mode: 'rag_lite', ...context }).slice(0, 4000), nowISO());
  res.json({ answer, context, mode: 'rag_lite' });
}

function buildScopePromptAddendum(allowedFactoryIds, isAdminScope) {
  if (isAdminScope) return '';
  if (!allowedFactoryIds || allowedFactoryIds.length === 0) {
    return `\n\n## 보안 규칙 (필수)\n현재 사용자는 어떤 공장 데이터도 접근할 수 없습니다. 차량/배터리/경보 조회 시 결과가 반드시 0건이 되어야 합니다. SQL: SELECT 0 AS no_access LIMIT 1 으로 응답하세요.`;
  }
  const list = allowedFactoryIds.join(', ');
  return `\n\n## 보안 규칙 (필수)\n현재 사용자는 factory_id IN (${list}) 인 공장 데이터만 조회할 수 있습니다.\n- 차량 관련 테이블(cars, alerts, batteries, battery_measurements, battery_cells, battery_cell_measurements, car_status_histories, alert_status_histories, process_step_histories, inspection_results) 중 하나라도 참조하면 반드시 cars 테이블을 JOIN하고 \`WHERE cars.factory_id IN (${list})\` 조건을 추가해야 합니다.\n- 예: \`SELECT bm.soc FROM battery_measurements bm JOIN batteries b ON b.battery_id=bm.battery_id JOIN cars c ON c.car_id=b.car_id WHERE c.factory_id IN (${list})\`\n- alerts 조회 시도 cars JOIN 필수: \`JOIN cars c ON c.car_id=a.car_id WHERE c.factory_id IN (${list})\`\n- 위 IN-list에 없는 factory_id를 SQL에 절대 포함하지 마세요. 검증기가 차단합니다.\n- factories/countries 메타 테이블만 조회하는 경우는 예외입니다.`;
}

async function handleTextToSql(req, res, { baseURL, model }) {
  const { message, session_id, locale } = req.body;

  const scopeAddendum = buildScopePromptAddendum(req.allowedFactoryIds, req.isAdminScope);
  const qLabel = locale === 'en' ? 'User question' : '사용자 질문';
  const jsonHint = locale === 'en' ? 'Respond with JSON only' : 'JSON으로만 답하세요';
  const sqlUserContent = `${SCHEMA_PROMPT}${scopeAddendum}\n\n${qLabel}: ${message}\n\n${jsonHint}: {"sql": "...", "reasoning": "..."}`;
  const sqlStep = await callLlm({
    baseURL, model,
    systemPrompt: SQL_SYSTEM_PROMPT,
    userContent: sqlUserContent,
  });

  let parsed;
  try {
    parsed = extractJson(sqlStep.answer);
  } catch (e) {
    const err = new Error(`LLM이 생성한 SQL JSON을 파싱할 수 없습니다: ${e.message}`);
    err.detail = sqlStep.answer.slice(0, 600);
    err.status = 502;
    throw err;
  }
  if (!parsed.sql || typeof parsed.sql !== 'string') {
    const err = new Error('LLM 응답에 sql 필드가 없습니다');
    err.detail = JSON.stringify(parsed).slice(0, 600);
    err.status = 502;
    throw err;
  }

  let rawSql = parsed.sql;
  try {
    validateSql(rawSql, req.allowedFactoryIds, req.isAdminScope);
  } catch (e) {
    const err = new Error(`SQL 검증 실패: ${e.message}`);
    err.detail = `생성된 SQL: ${rawSql}`;
    err.status = 502;
    throw err;
  }
  const finalSql = injectLimit(rawSql, 100);

  let rows;
  try {
    rows = db.prepare(finalSql).all();
  } catch (e) {
    const err = new Error(`SQL 실행 실패: ${e.message}`);
    err.detail = `SQL: ${finalSql}`;
    err.status = 502;
    throw err;
  }

  const resultsText = JSON.stringify(rows, null, 2);
  const answerUserContent = locale === 'en'
    ? `User question: ${message}\n\nExecuted SQL:\n${finalSql}\n\nQuery results (${rows.length} rows, JSON):\n${resultsText}\n\nBased on the results above, answer concisely in English. If the result is empty, say "No matching data found". Translate Korean factory/model/country names to English.`
    : `사용자 질문: ${message}\n\n실행한 SQL:\n${finalSql}\n\n쿼리 결과 (${rows.length}건, JSON):\n${resultsText}\n\n위 결과를 바탕으로 한국어로 간결하게 답변하세요. 결과가 비어있으면 "해당하는 데이터가 없습니다"라고 알려주세요.`;
  const { answer } = await callLlm({
    baseURL, model,
    systemPrompt: systemPromptForLocale(locale),
    userContent: answerUserContent,
  });

  const context = {
    mode: 'text_to_sql',
    sql: finalSql,
    reasoning: parsed.reasoning || null,
    rows_count: rows.length,
    rows: rows.slice(0, 50),
  };
  db.prepare('INSERT INTO llm_chat_logs (user_id,session_id,user_message,assistant_message,context_data,created_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.uid, session_id || null, message, answer, JSON.stringify(context).slice(0, 4000), nowISO());
  res.json({ answer, context, mode: 'text_to_sql' });
}

// 대화 내용을 리포트로 저장 — LLM으로 요약 + 핵심 발견 + 액션 아이템 생성
const REPORT_SYSTEM_PROMPT_KO = `당신은 BMS 품질검사 대시보드의 리포트 작성 전문가입니다.
사용자와 챗봇의 대화를 토대로 운영자가 빠르게 읽을 수 있는 리포트를 작성합니다.
반드시 다음 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이):
{
  "title": "리포트 제목 (40자 이내, 핵심 주제)",
  "summary": "2~3 문장 요약",
  "key_findings": ["핵심 발견 1", "핵심 발견 2", ...],
  "action_items": ["권장 액션 1", "권장 액션 2", ...],
  "data_points": ["인용 데이터 (차량 ID, 수치 등)", ...]
}
제공된 대화에 없는 내용은 절대 만들어내지 마세요. 데이터/숫자/차량ID는 대화에 등장한 그대로 인용하세요.`;

const REPORT_SYSTEM_PROMPT_EN = `You are a report writing specialist for the BMS quality inspection dashboard.
Write a concise report from the user-chatbot conversation that an operator can read quickly.
Respond ONLY with JSON in this format (no markdown code blocks):
{
  "title": "Report title (under 40 chars, core topic)",
  "summary": "2-3 sentence summary",
  "key_findings": ["Finding 1", "Finding 2", ...],
  "action_items": ["Recommended action 1", ...],
  "data_points": ["Cited data (vehicle IDs, values, etc.)", ...]
}
NEVER fabricate content not in the conversation. Cite data/numbers/vehicle IDs verbatim.`;

router.post('/report', authRequired, async (req, res) => {
  const { messages, session_id, locale, title: userTitle } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 배열이 비어있습니다' });
  }
  // user/assistant role만, 빈 메시지 제외
  const cleaned = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim() }));
  if (cleaned.length === 0) {
    return res.status(400).json({ error: '유효한 메시지가 없습니다' });
  }

  const baseURL = process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = getSetting('llm_model', process.env.LLM_MODEL || 'local-model');
  const llmMode = getSetting('llm_mode', 'rag_lite');
  const isEn = locale === 'en';

  // 대화 직렬화
  const conversationText = cleaned.map((m, i) => {
    const tag = m.role === 'user' ? (isEn ? 'User' : '사용자') : (isEn ? 'Assistant' : '챗봇');
    return `[${i + 1}] ${tag}:\n${m.content}`;
  }).join('\n\n');

  // 차량 ID 추출
  const carIdSet = new Set();
  cleaned.forEach(m => {
    const ids = m.content.match(/VH-\d{8}-\d{4}/g) || [];
    ids.forEach(id => carIdSet.add(id));
  });
  const carIds = Array.from(carIdSet);

  let summaryJson;
  try {
    const userContent = isEn
      ? `Below is a conversation between an operator and the BMS chatbot. Generate a JSON report.\n\n--- Conversation ---\n${conversationText}\n--- End ---`
      : `아래는 운영자와 BMS 챗봇의 대화입니다. JSON 리포트를 생성하세요.\n\n--- 대화 시작 ---\n${conversationText}\n--- 대화 끝 ---`;
    const { answer } = await callLlm({
      baseURL,
      model,
      systemPrompt: isEn ? REPORT_SYSTEM_PROMPT_EN : REPORT_SYSTEM_PROMPT_KO,
      userContent,
      maxTokens: 2000,
    });
    summaryJson = extractJson(answer);
  } catch (e) {
    // LLM 요약 실패해도 원본 대화는 저장
    summaryJson = {
      title: userTitle || (isEn ? 'Conversation Report' : '대화 리포트'),
      summary: isEn ? '(Auto-summary failed; raw conversation preserved.)' : '(자동 요약 실패 — 원본 대화는 보존됨.)',
      key_findings: [],
      action_items: [],
      data_points: [],
      _llm_error: String(e.message || e).slice(0, 200),
    };
  }

  const finalTitle = (userTitle && String(userTitle).trim()) || summaryJson.title || (isEn ? 'Untitled Report' : '제목 없음');
  const content = {
    summary: summaryJson.summary || '',
    key_findings: Array.isArray(summaryJson.key_findings) ? summaryJson.key_findings : [],
    action_items: Array.isArray(summaryJson.action_items) ? summaryJson.action_items : [],
    data_points: Array.isArray(summaryJson.data_points) ? summaryJson.data_points : [],
    messages: cleaned,
    locale: isEn ? 'en' : 'ko',
    generated_at: nowISO(),
    _llm_error: summaryJson._llm_error || null,
  };

  const result = db.prepare(`
    INSERT INTO reports (user_id, title, summary, content, source_session_id, llm_mode, llm_model, message_count, car_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.uid,
    finalTitle.slice(0, 200),
    (content.summary || '').slice(0, 500),
    JSON.stringify(content),
    session_id || null,
    llmMode,
    model,
    cleaned.length,
    JSON.stringify(carIds),
    nowISO(),
  );
  res.json({ report_id: result.lastInsertRowid, title: finalTitle });
});

router.post('/', ...authAndScope, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message 필수' });

  const baseURL = process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = getSetting('llm_model', process.env.LLM_MODEL || 'local-model');
  const mode = getSetting('llm_mode', 'rag_lite');

  try {
    if (mode === 'text_to_sql') {
      await handleTextToSql(req, res, { baseURL, model });
    } else {
      await handleRagLite(req, res, { baseURL, model });
    }
  } catch (e) {
    if (e.status && e.detail !== undefined) {
      return res.status(e.status).json({ error: e.message, detail: e.detail });
    }
    const msg = String(e.message || e);
    let hint = 'LLM 서버에 연결할 수 없습니다. LM Studio가 실행 중인지 확인해주세요.';
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) hint = `LM Studio(${baseURL})에 연결 실패. 서버가 실행 중인지 확인하세요.`;
    else if (/timeout|aborted/i.test(msg)) hint = 'LLM 응답 대기 시간 초과. (모델 첫 추론 cold start일 수 있음 — 잠시 후 다시 시도)';
    res.status(502).json({ error: hint, detail: msg });
  }
});

export default router;

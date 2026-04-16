import bcrypt from 'bcryptjs';
import { db, nowISO } from './index.js';
import { createVehicle } from '../services/vehicleFactory.js';
import { STATUSES } from '../services/constants.js';

const DEFAULT_SETTINGS = [
  ['vehicle_generation_interval_ms', '10000', 'INTEGER', '차량 자동 생성 간격'],
  ['inspection_soc_duration_ms', '10000', 'INTEGER', 'SOC 검사 시간'],
  ['inspection_soh_duration_ms', '10000', 'INTEGER', 'SOH 검사 시간'],
  ['inspection_sop_duration_ms', '10000', 'INTEGER', 'SOP 검사 시간'],
  ['inspection_pack_voltage_duration_ms', '10000', 'INTEGER', '팩 전압 검사 시간'],
  ['inspection_cell_duration_ms', '10000', 'INTEGER', '셀 검사 시간'],
  ['qa_maintenance_duration_ms', '10000', 'INTEGER', '정비(QA) 시간'],
  ['re_inspection_duration_ms', '10000', 'INTEGER', '재검사 단계 시간'],
  ['shipment_waiting_duration_ms', '10000', 'INTEGER', '출고 대기 시간'],
  ['shipment_complete_delay_ms', '10000', 'INTEGER', '출고 완료 지연'],
  ['prob_soc_normal', '99', 'INTEGER', 'SOC 정상 확률(%)'],
  ['prob_soh_normal', '99', 'INTEGER', 'SOH 정상 확률(%)'],
  ['prob_sop_normal', '99', 'INTEGER', 'SOP 정상 확률(%)'],
  ['prob_pack_voltage_normal', '99', 'INTEGER', '팩 전압 정상 확률(%)'],
  ['prob_cell_temperature_normal', '99', 'INTEGER', '셀 온도 정상 확률(%)'],
  ['prob_cell_voltage_normal', '99', 'INTEGER', '셀 전압 정상 확률(%)'],
  ['llm_model', 'local-model', 'STRING', 'LLM 모델 (LM Studio에 로드된 모델 중 선택)'],
  ['llm_mode', 'rag_lite', 'STRING', 'LLM 응답 방식 (rag_lite: 키워드 기반 / text_to_sql: SQL 생성)'],
  ['llm_max_tokens', '3000', 'INTEGER', 'LLM 응답 최대 토큰 수 (생성될 답변 길이 한도)'],
  ['llm_context_alerts', '8', 'INTEGER', 'RAG-lite 컨텍스트에 포함할 최근 경보 건수'],
  ['llm_context_cars', '20', 'INTEGER', 'RAG-lite 컨텍스트에 포함할 키워드 매칭 차량 건수'],
  ['llm_alert_msg_max', '80', 'INTEGER', '경보 메시지 자르기 글자수 (0이면 자르지 않음)'],
  ['shift_duration_min', '30', 'INTEGER', '교대조 주기 (분)'],
  ['repair_duration_multiplier', '2', 'FLOAT', '수리 시간 배수 (검사 시간 × 배수)'],
];

const FACTORIES = [
  ['청림공장', '청림', '에버랜드', '노바'],
  ['은하공장', '은하', '에버랜드', '노바'],
  ['백운공장', '백운', '에버랜드', '노바'],
  ['단풍공장', '단풍', '에버랜드', '벡터'],
  ['태양공장', '태양', '에버랜드', '벡터'],
  ['한빛공장', '한빛', '에버랜드', '벡터'],
];

const COUNTRIES = [
  ['에버랜드', 'KR'], ['미국', 'US'], ['독일', 'DE'], ['영국', 'GB'],
  ['프랑스', 'FR'], ['일본', 'JP'], ['중국', 'CN'], ['인도', 'IN'],
  ['호주', 'AU'], ['캐나다', 'CA'],
];

export function seedIfEmpty() {
  // brand 컬럼 마이그레이션 (이미 있으면 예외 무시)
  try { db.exec('ALTER TABLE factories ADD COLUMN brand TEXT'); } catch {}

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const hashAdmin = bcrypt.hashSync('admin1234', 10);
    const hashOp = bcrypt.hashSync('operator1234', 10);
    db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run('admin@evernex.com', hashAdmin, 'admin', '관리자');
    db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)').run('operator@evernex.com', hashOp, 'operator', '운영자');
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM factories').get().c === 0) {
    const stmt = db.prepare('INSERT INTO factories (factory_name,region,country,brand,is_active) VALUES (?,?,?,?,1)');
    FACTORIES.forEach(f => stmt.run(...f));
  } else {
    // 기존 DB에 brand가 비어있으면 이름 기준으로 보충
    const brandByName = Object.fromEntries(FACTORIES.map(f => [f[0], f[3]]));
    const existing = db.prepare('SELECT factory_id, factory_name, brand FROM factories').all();
    const upd = db.prepare('UPDATE factories SET brand=? WHERE factory_id=?');
    existing.forEach(r => {
      const b = brandByName[r.factory_name];
      if (b && r.brand !== b) upd.run(b, r.factory_id);
    });
    // 백운공장 신규 추가 (없을 때만)
    if (db.prepare("SELECT COUNT(*) AS c FROM factories WHERE factory_name='백운공장'").get().c === 0) {
      db.prepare('INSERT INTO factories (factory_name,region,country,brand,is_active) VALUES (?,?,?,?,1)')
        .run('백운공장', '백운', '에버랜드', '노바');
    }
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM countries').get().c === 0) {
    const stmt = db.prepare('INSERT INTO countries (country_name,country_code,is_allowed) VALUES (?,?,1)');
    COUNTRIES.forEach(c => stmt.run(...c));
  }
  const setStmt = db.prepare('INSERT OR IGNORE INTO admin_settings (setting_key,setting_value,setting_type,description,updated_at) VALUES (?,?,?,?,?)');
  DEFAULT_SETTINGS.forEach(s => setStmt.run(s[0], s[1], s[2], s[3], nowISO()));

  // 시드 operator에게 모든 공장 권한 부여 (최초 1회만; 매핑이 이미 있으면 건너뜀)
  const seedOp = db.prepare("SELECT user_id FROM users WHERE email='operator@evernex.com'").get();
  if (seedOp) {
    const opMappings = db.prepare('SELECT COUNT(*) AS c FROM user_factories WHERE user_id=?').get(seedOp.user_id).c;
    if (opMappings === 0) {
      const allFids = db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id);
      const ins = db.prepare('INSERT OR IGNORE INTO user_factories (user_id, factory_id) VALUES (?, ?)');
      allFids.forEach(fid => ins.run(seedOp.user_id, fid));
    }
  }

  const carCount = db.prepare('SELECT COUNT(*) AS c FROM cars').get().c;
  if (carCount === 0) {
    // Create sample cars across all statuses
    const sampleStatuses = [
      STATUSES.ARRIVAL, STATUSES.BATTERY_INSPECTION, STATUSES.CELL_INSPECTION,
      STATUSES.ANOMALY_DETECTED, STATUSES.QA_MAINTENANCE, STATUSES.RE_INSPECTION_WAITING,
      STATUSES.RE_INSPECTION, STATUSES.BATTERY_QC_COMPLETE, STATUSES.SHIPMENT_WAITING,
      STATUSES.SHIPMENT_COMPLETE,
      STATUSES.BATTERY_INSPECTION, STATUSES.CELL_INSPECTION,
      STATUSES.ANOMALY_DETECTED, STATUSES.SHIPMENT_WAITING, STATUSES.ARRIVAL,
    ];
    sampleStatuses.forEach((st, i) => {
      const forceAbnormal = [STATUSES.ANOMALY_DETECTED, STATUSES.QA_MAINTENANCE, STATUSES.RE_INSPECTION_WAITING, STATUSES.RE_INSPECTION].includes(st);
      createVehicle({ initialStatus: st, forceAbnormal, seqOverride: i + 1 });
    });
  }
}

import { db, nowISO } from '../db/index.js';
import { STATUSES, INSPECTION_STEPS, RANGES } from './constants.js';
import { getSetting } from './settings.js';
import { createVehicle, initSeqFromDb } from './vehicleFactory.js';
import { isNormal, genMetric, classifySeverity } from './random.js';

// Per-car simulation state in memory
const carTimers = new Map(); // carId -> { nextAt: ms, phase: 'STEP'|'QA'|'WAIT', stepIdx, reInspection }

function updateStatus(carId, status, reason) {
  const now = nowISO();
  db.prepare('UPDATE cars SET current_status=?, current_status_updated_at=?, updated_at=? WHERE car_id=?').run(status, now, now, carId);
  db.prepare('INSERT INTO car_status_histories (car_id,status,changed_at,reason) VALUES (?,?,?,?)').run(carId, status, now, reason || null);
}

function latestMeasurement(carId) {
  return db.prepare(`SELECT bm.* FROM battery_measurements bm
    JOIN batteries b ON b.battery_id=bm.battery_id
    WHERE b.car_id=? ORDER BY bm.inspected_at DESC LIMIT 1`).get(carId);
}
function latestCells(carId) {
  return db.prepare(`SELECT bcm.*, bc.cell_number FROM battery_cell_measurements bcm
    JOIN battery_cells bc ON bc.cell_id=bcm.cell_id
    JOIN batteries b ON b.battery_id=bc.battery_id
    WHERE b.car_id=?
    AND bcm.cell_measurement_id IN (
      SELECT MAX(cell_measurement_id) FROM battery_cell_measurements GROUP BY cell_id
    )
    ORDER BY bc.cell_number`).all(carId);
}

function insertStepHistory(carId, step, status, startedAt, endedAt, note) {
  db.prepare(`INSERT INTO process_step_histories (car_id,step_name,step_order,step_status,started_at,ended_at,note)
              VALUES (?,?,?,?,?,?,?)`).run(carId, step.name, step.order, status, startedAt || null, endedAt || null, note || null);
}

function createAlert(carId, type, message, severity = 'HIGH') {
  const now = nowISO();
  const r = db.prepare(`INSERT INTO alerts (car_id,alert_type,alert_message,severity,occurred_at,current_status) VALUES (?,?,?,?,?,?)`)
    .run(carId, type, message, severity, now, 'OPEN');
  db.prepare(`INSERT INTO alert_status_histories (alert_id,previous_status,new_status,changed_at,note) VALUES (?,?,?,?,?)`)
    .run(r.lastInsertRowid, null, 'OPEN', now, '자동 발생');
  return r.lastInsertRowid;
}

function evalStep(carId, step) {
  const meas = latestMeasurement(carId);
  const cells = latestCells(carId);
  let passed = true;
  let failNote = null;
  let kind = null;
  let value = null;
  if (step.name === 'SOC_CHECK' && !isNormal('soc', meas.soc)) {
    passed = false; failNote = `SOC 이상치 ${meas.soc}%`; kind = 'soc'; value = meas.soc;
  } else if (step.name === 'SOH_CHECK' && !isNormal('soh', meas.soh)) {
    passed = false; failNote = `SOH 이상치 ${meas.soh}%`; kind = 'soh'; value = meas.soh;
  } else if (step.name === 'SOP_CHECK' && !isNormal('sop', meas.sop)) {
    passed = false; failNote = `SOP 이상치 ${meas.sop}%`; kind = 'sop'; value = meas.sop;
  } else if (step.name === 'PACK_VOLTAGE_CHECK' && !isNormal('pack_voltage', meas.avg_voltage)) {
    passed = false; failNote = `팩 전압 이상치 ${meas.avg_voltage}V`; kind = 'pack_voltage'; value = meas.avg_voltage;
  } else if (step.name === 'CELL_TEMPERATURE_CHECK') {
    const bad = cells.find(c => !isNormal('cell_temperature', c.cell_temperature));
    if (bad) { passed = false; failNote = `셀 #${bad.cell_number} 온도 이상 ${bad.cell_temperature}℃`; kind = 'cell_temperature'; value = bad.cell_temperature; }
  } else if (step.name === 'CELL_VOLTAGE_CHECK') {
    const bad = cells.find(c => !isNormal('cell_voltage', c.cell_voltage));
    if (bad) { passed = false; failNote = `셀 #${bad.cell_number} 전압 이상 ${bad.cell_voltage}V`; kind = 'cell_voltage'; value = bad.cell_voltage; }
  }
  const severity = passed ? null : (classifySeverity(kind, value) || 'HIGH');
  return { passed, failNote, severity };
}

function startStep(carId, stepIdx) {
  const step = INSPECTION_STEPS[stepIdx];
  const now = nowISO();
  const status = stepIdx <= 3 ? STATUSES.BATTERY_INSPECTION : STATUSES.CELL_INSPECTION;
  const st = db.prepare('SELECT current_status FROM cars WHERE car_id=?').get(carId)?.current_status;
  if (st === STATUSES.RE_INSPECTION) {
    // keep
  } else if (st !== status) {
    updateStatus(carId, status, `${step.labelKR} 시작`);
  }
  insertStepHistory(carId, step, 'IN_PROGRESS', now, null, null);
  const dur = getSetting(step.durationKey, 10000);
  const state = carTimers.get(carId) || {};
  carTimers.set(carId, { ...state, phase: 'STEP', stepIdx, nextAt: Date.now() + dur });
}

function finishStep(carId, stepIdx) {
  const step = INSPECTION_STEPS[stepIdx];
  const now = nowISO();
  const { passed, failNote, severity } = evalStep(carId, step);
  insertStepHistory(carId, step, passed ? 'PASS' : 'FAIL', null, now, failNote);
  if (!passed) {
    createAlert(carId, step.name, `${step.labelKR} 실패: ${failNote}`, severity);
    db.prepare(`INSERT INTO inspection_results (car_id,status,reason,performance_status,safety_status,evaluated_at)
                VALUES (?,?,?,?,?,?)`).run(carId, 'FAIL', failNote, 'FAIL', 'FAIL', now);
    const state = carTimers.get(carId) || {};
    const failedStepIdxs = Array.isArray(state.failedStepIdxs) ? [...state.failedStepIdxs, stepIdx] : [stepIdx];
    carTimers.set(carId, { ...state, failedStepIdxs });
  }
}

function getRepairMultiplier() {
  const m = getSetting('repair_duration_multiplier', 2);
  return Number.isFinite(m) && m > 0 ? m : 2;
}

function repairDurationFor(stepIdx) {
  const step = INSPECTION_STEPS[stepIdx];
  return getSetting(step.durationKey, 10000) * getRepairMultiplier();
}

function enterQaFromFailures(carId) {
  const state = carTimers.get(carId) || {};
  const failedStepIdxs = (state.failedStepIdxs || []).slice();
  updateStatus(carId, STATUSES.ANOMALY_DETECTED, '검사 실패 항목 발견');
  // 전환 상태로 즉시 잠금(tickCar 재진입 방지).
  carTimers.set(carId, { phase: 'QA_TRANSITION', failedStepIdxs, nextAt: Date.now() + 60_000 });
  setTimeout(() => {
    updateStatus(carId, STATUSES.QA_MAINTENANCE, '자동 QA 진입');
    if (failedStepIdxs.length === 0) {
      // 폴백: 실패 정보 유실 → 기존 단일 대기 후 bulk resolve
      const dur = getSetting('qa_maintenance_duration_ms', 10000);
      carTimers.set(carId, { phase: 'QA_WAIT_RESOLVE', failedStepIdxs, nextAt: Date.now() + dur });
    } else {
      // 순차 수리: 첫 실패 항목의 수리 완료 시점을 예약
      carTimers.set(carId, {
        phase: 'QA_REPAIR_STEP',
        repairQueue: failedStepIdxs.slice(),
        failedStepIdxs,
        nextAt: Date.now() + repairDurationFor(failedStepIdxs[0]),
      });
    }
  }, 500);
}

function repairOneStep(carId, stepIdx) {
  const now = nowISO();
  const battery = db.prepare('SELECT battery_id FROM batteries WHERE car_id=?').get(carId);
  if (!battery) return;
  const latest = latestMeasurement(carId);
  if (stepIdx <= 3 && latest) {
    const newSoc = stepIdx === 0 ? clampRange('soc', genMetric('soc')) : latest.soc;
    const newSoh = stepIdx === 1 ? clampRange('soh', genMetric('soh')) : latest.soh;
    const newSop = stepIdx === 2 ? clampRange('sop', genMetric('sop')) : latest.sop;
    const newPackV = stepIdx === 3 ? clampRange('pack_voltage', genMetric('pack_voltage')) : latest.avg_voltage;
    db.prepare(`INSERT INTO battery_measurements (battery_id,inspected_at,soc,soh,sop,avg_voltage,avg_temperature,temperature_deviation)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      battery.battery_id, now, newSoc, newSoh, newSop, newPackV, latest.avg_temperature, latest.temperature_deviation
    );
  } else if (stepIdx === 4 || stepIdx === 5) {
    const cellRows = latestCells(carId);
    if (!cellRows.length) return;
    const stmt = db.prepare('INSERT INTO battery_cell_measurements (cell_id,measured_at,cell_temperature,cell_voltage) VALUES (?,?,?,?)');
    cellRows.forEach(c => {
      const newTemp = stepIdx === 4 ? clampRange('cell_temperature', genMetric('cell_temperature')) : c.cell_temperature;
      const newVolt = stepIdx === 5 ? clampRange('cell_voltage', genMetric('cell_voltage')) : c.cell_voltage;
      stmt.run(c.cell_id, now, newTemp, newVolt);
    });
  }
}

function finalizeRepairAndStartReWait(carId, failedStepIdxs, userId) {
  const now = nowISO();
  const openAlerts = db.prepare("SELECT alert_id,current_status FROM alerts WHERE car_id=? AND current_status!='RESOLVED'").all(carId);
  const upd = db.prepare("UPDATE alerts SET current_status='RESOLVED', resolved_at=? WHERE alert_id=?");
  const hist = db.prepare('INSERT INTO alert_status_histories (alert_id,previous_status,new_status,changed_by_user_id,changed_at,note) VALUES (?,?,?,?,?,?)');
  openAlerts.forEach(a => {
    upd.run(now, a.alert_id);
    hist.run(a.alert_id, a.current_status, 'RESOLVED', userId || null, now, userId ? '운영자 해결' : '자동 수리 완료');
  });
  updateStatus(carId, STATUSES.RE_INSPECTION_WAITING, '수리 완료 — 재검사 대기');
  const waitDur = getSetting('re_inspection_duration_ms', 10000);
  carTimers.set(carId, { phase: 'RE_WAIT', failedStepIdxs: failedStepIdxs.slice(), nextAt: Date.now() + waitDur });
}

function startReInspectionChain(carId, stepsToRun) {
  const queue = (stepsToRun && stepsToRun.length ? stepsToRun : [0, 1, 2, 3, 4, 5]).slice();
  updateStatus(carId, STATUSES.RE_INSPECTION, '재검사 시작');
  carTimers.set(carId, { phase: 'STEP', stepIdx: queue[0], remainingStepQueue: queue, failedStepIdxs: [], nextAt: Date.now() });
  startStep(carId, queue[0]);
}

function startShipmentWaiting(carId) {
  updateStatus(carId, STATUSES.SHIPMENT_WAITING, '출고 대기');
  const dur = getSetting('shipment_waiting_duration_ms', 10000);
  carTimers.set(carId, { phase: 'SHIPMENT_WAIT', nextAt: Date.now() + dur });
}

function markShipped(carId) {
  updateStatus(carId, STATUSES.SHIPMENT_COMPLETE, '출고 완료');
  carTimers.delete(carId);
}

function beginNewVehicle(carId) {
  updateStatus(carId, STATUSES.BATTERY_INSPECTION, '검사 시작');
  carTimers.set(carId, { failedStepIdxs: [], remainingStepQueue: null });
  startStep(carId, 0);
}

function clampRange(k, v) { const r = RANGES[k]; return Math.min(Math.max(v, r.min + 0.1), r.max - 0.1); }

// Called when operator resolves alert (수동) — 남은 수리 항목을 즉시 일괄 처리 후 재검사 대기로 전환
export function resolveAlertAndReinspect(carId, userId) {
  const battery = db.prepare('SELECT battery_id FROM batteries WHERE car_id=?').get(carId);
  if (!battery) return false;
  const state = carTimers.get(carId) || {};
  const failed = Array.isArray(state.failedStepIdxs) ? state.failedStepIdxs : [];
  // 아직 수리되지 않은 항목만 선별 (순차 수리 중이면 repairQueue, 아니면 failedStepIdxs)
  const remaining = Array.isArray(state.repairQueue) ? state.repairQueue.slice() : failed.slice();

  if (remaining.length === 0 && failed.length === 0) {
    // 폴백(실패 정보 유실): 전체 재생성
    const now = nowISO();
    db.prepare(`INSERT INTO battery_measurements (battery_id,inspected_at,soc,soh,sop,avg_voltage,avg_temperature,temperature_deviation)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      battery.battery_id, now,
      clampRange('soc', genMetric('soc')),
      clampRange('soh', genMetric('soh')),
      clampRange('sop', genMetric('sop')),
      clampRange('pack_voltage', genMetric('pack_voltage')),
      clampRange('cell_temperature', genMetric('cell_temperature')),
      0.5
    );
    const cells = db.prepare('SELECT cell_id FROM battery_cells WHERE battery_id=?').all(battery.battery_id);
    const stmt = db.prepare('INSERT INTO battery_cell_measurements (cell_id,measured_at,cell_temperature,cell_voltage) VALUES (?,?,?,?)');
    cells.forEach(c => stmt.run(c.cell_id, now, clampRange('cell_temperature', genMetric('cell_temperature')), clampRange('cell_voltage', genMetric('cell_voltage'))));
  } else {
    remaining.forEach(idx => repairOneStep(carId, idx));
  }

  finalizeRepairAndStartReWait(carId, failed, userId);
  return true;
}

// Called on boot for any in-progress cars
function resumeCar(carId, status) {
  const now = Date.now();
  const small = now + 1500;
  if (status === STATUSES.ARRIVAL) {
    carTimers.set(carId, { phase: 'ARRIVAL', nextAt: small });
  } else if (status === STATUSES.BATTERY_INSPECTION || status === STATUSES.CELL_INSPECTION) {
    // restart step 0
    startStep(carId, 0);
  } else if (status === STATUSES.ANOMALY_DETECTED) {
    carTimers.set(carId, { phase: 'ANOMALY_WAIT', nextAt: small });
  } else if (status === STATUSES.QA_MAINTENANCE) {
    const dur = getSetting('qa_maintenance_duration_ms', 10000);
    carTimers.set(carId, { phase: 'QA_WAIT_RESOLVE', nextAt: now + dur });
  } else if (status === STATUSES.RE_INSPECTION_WAITING) {
    const dur = getSetting('re_inspection_duration_ms', 10000);
    carTimers.set(carId, { phase: 'RE_WAIT', nextAt: now + dur });
  } else if (status === STATUSES.RE_INSPECTION) {
    startStep(carId, 0);
  } else if (status === STATUSES.BATTERY_QC_COMPLETE) {
    carTimers.set(carId, { phase: 'BQC_DONE', nextAt: small });
  } else if (status === STATUSES.SHIPMENT_WAITING) {
    const dur = getSetting('shipment_waiting_duration_ms', 10000);
    carTimers.set(carId, { phase: 'SHIPMENT_WAIT', nextAt: now + dur });
  }
  // SHIPMENT_COMPLETE: no timer
}

function tickCar(carId) {
  const state = carTimers.get(carId);
  if (!state || Date.now() < state.nextAt) return;
  const car = db.prepare('SELECT current_status FROM cars WHERE car_id=?').get(carId);
  if (!car) { carTimers.delete(carId); return; }

  if (state.phase === 'ARRIVAL') { beginNewVehicle(carId); return; }
  if (state.phase === 'STEP') {
    const justFinishedIdx = state.stepIdx;
    finishStep(carId, justFinishedIdx);
    const updated = carTimers.get(carId) || {};
    const queue = Array.isArray(updated.remainingStepQueue) ? updated.remainingStepQueue : null;
    if (queue) {
      // 재검사 모드: 큐에서 방금 끝낸 인덱스 제거
      const nextQueue = queue.filter(i => i !== justFinishedIdx);
      if (nextQueue.length > 0) {
        carTimers.set(carId, { ...updated, remainingStepQueue: nextQueue });
        startStep(carId, nextQueue[0]);
      } else {
        // 재검사 라운드 종료
        const roundFails = updated.failedStepIdxs || [];
        if (roundFails.length > 0) {
          carTimers.set(carId, { ...updated, remainingStepQueue: null });
          enterQaFromFailures(carId);
        } else {
          updateStatus(carId, STATUSES.BATTERY_QC_COMPLETE, '재검사 통과');
          carTimers.set(carId, { phase: 'BQC_DONE', nextAt: Date.now() + 1500 });
        }
      }
    } else {
      // 첫 검사 모드
      const nextIdx = justFinishedIdx + 1;
      if (nextIdx >= INSPECTION_STEPS.length) {
        const fails = updated.failedStepIdxs || [];
        if (fails.length > 0) {
          enterQaFromFailures(carId);
        } else {
          updateStatus(carId, STATUSES.BATTERY_QC_COMPLETE, '모든 검사 통과');
          carTimers.set(carId, { phase: 'BQC_DONE', nextAt: Date.now() + 1500 });
        }
      } else {
        startStep(carId, nextIdx);
      }
    }
    return;
  }
  if (state.phase === 'QA_REPAIR_STEP') {
    const queue = Array.isArray(state.repairQueue) ? state.repairQueue : [];
    if (queue.length === 0) {
      finalizeRepairAndStartReWait(carId, state.failedStepIdxs || [], null);
      return;
    }
    const [currentIdx, ...rest] = queue;
    repairOneStep(carId, currentIdx);
    if (rest.length > 0) {
      carTimers.set(carId, { ...state, repairQueue: rest, nextAt: Date.now() + repairDurationFor(rest[0]) });
    } else {
      finalizeRepairAndStartReWait(carId, state.failedStepIdxs || [], null);
    }
    return;
  }
  if (state.phase === 'QA_WAIT_RESOLVE') {
    // auto-resolve if operator did not act within duration (폴백 경로)
    resolveAlertAndReinspect(carId, null);
    return;
  }
  if (state.phase === 'RE_WAIT') {
    const toRun = Array.isArray(state.failedStepIdxs) && state.failedStepIdxs.length
      ? state.failedStepIdxs
      : [0, 1, 2, 3, 4, 5];
    startReInspectionChain(carId, toRun);
    return;
  }
  if (state.phase === 'BQC_DONE') {
    startShipmentWaiting(carId);
    return;
  }
  if (state.phase === 'SHIPMENT_WAIT') {
    markShipped(carId);
    const dur = getSetting('shipment_complete_delay_ms', 10000);
    setTimeout(() => {}, dur);
    return;
  }
  if (state.phase === 'ANOMALY_WAIT') {
    updateStatus(carId, STATUSES.QA_MAINTENANCE, '자동 QA 진입');
    const dur = getSetting('qa_maintenance_duration_ms', 10000);
    carTimers.set(carId, { phase: 'QA_WAIT_RESOLVE', nextAt: Date.now() + dur });
  }
}

let generationTimer = null;
let lastGenAt = 0;

export function startSimulation() {
  initSeqFromDb();
  // Resume all cars not in SHIPMENT_COMPLETE
  const cars = db.prepare("SELECT car_id,current_status FROM cars WHERE current_status != 'SHIPMENT_COMPLETE'").all();
  cars.forEach(c => resumeCar(c.car_id, c.current_status));

  const loop = setInterval(() => {
    for (const carId of Array.from(carTimers.keys())) tickCar(carId);
    const interval = getSetting('vehicle_generation_interval_ms', 10000);
    if (Date.now() - lastGenAt >= interval) {
      const { carId } = createVehicle({ initialStatus: STATUSES.ARRIVAL });
      resumeCar(carId, STATUSES.ARRIVAL);
      lastGenAt = Date.now();
    }
  }, 500);
  generationTimer = loop;
}

export function stopSimulation() { if (generationTimer) clearInterval(generationTimer); }

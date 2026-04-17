import { Router } from 'express';
import { db } from '../db/index.js';
import { authAndScope } from '../middleware/auth.js';
import { STATUSES } from '../services/constants.js';
import { getSetting } from '../services/settings.js';
import { factoryScopeClause, intersectFactoryIds, parseFactoryIdsParam } from '../db/factoryScope.js';

const router = Router();

function getCurrentShift() {
  const durationMin = getSetting('shift_duration_min', 30);
  const SHIFT_MS = durationMin * 60 * 1000;
  const now = Date.now();
  const startMs = Math.floor(now / SHIFT_MS) * SHIFT_MS;
  const endMs = startMs + SHIFT_MS;
  const toISO = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  return { shiftStart: toISO(startMs), shiftEnd: toISO(endMs), durationMin };
}

router.get('/stats', ...authAndScope, (req, res) => {
  const { shiftStart, shiftEnd, durationMin } = getCurrentShift();
  const requested = parseFactoryIdsParam(req.query.factory_ids);
  const effective = intersectFactoryIds(requested, req.allowedFactoryIds);

  // 권한 0개 또는 교집합 0개면 통계 전부 0으로 단락
  if (effective.length === 0) {
    const byStatus = Object.fromEntries(Object.values(STATUSES).map(s => [s, 0]));
    return res.json({
      total: 0, byStatus, openAlerts: 0, recentAlerts: [],
      inspecting: 0, anomalies: 0, arrival: 0, reInspectionWaiting: 0, qcComplete: 0, shipmentWaiting: 0, shipped: 0,
      inspectingCars: [], anomalyCars: [], arrivalCars: [], reInspWaitCars: [], qcCompleteCars: [], shipWaitingCars: [],
      shiftStart, shiftEnd, durationMin,
    });
  }

  const fScope = factoryScopeClause(effective, 'factory_id');
  const fParams = fScope.params;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM cars WHERE created_at >= ?${fScope.sql}`).get(shiftStart, ...fParams).c;
  const statusRows = db.prepare(`SELECT current_status AS status, COUNT(*) AS count FROM cars WHERE created_at >= ?${fScope.sql} GROUP BY current_status`).all(shiftStart, ...fParams);
  const byStatus = Object.fromEntries(Object.values(STATUSES).map(s => [s, 0]));
  statusRows.forEach(r => { byStatus[r.status] = r.count; });

  const aScope = factoryScopeClause(effective, 'c.factory_id');
  const openAlerts = db.prepare(`SELECT COUNT(*) AS c FROM alerts a JOIN cars c ON c.car_id=a.car_id WHERE a.current_status!='RESOLVED'${aScope.sql}`).get(...aScope.params).c;

  const shipped = byStatus[STATUSES.SHIPMENT_COMPLETE] || 0;
  const inspecting = (byStatus[STATUSES.BATTERY_INSPECTION] || 0) + (byStatus[STATUSES.CELL_INSPECTION] || 0) + (byStatus[STATUSES.RE_INSPECTION] || 0);
  const anomalies = (byStatus[STATUSES.ANOMALY_DETECTED] || 0) + (byStatus[STATUSES.QA_MAINTENANCE] || 0);
  const arrival = byStatus[STATUSES.ARRIVAL] || 0;
  const reInspectionWaiting = byStatus[STATUSES.RE_INSPECTION_WAITING] || 0;
  const qcComplete = byStatus[STATUSES.BATTERY_QC_COMPLETE] || 0;
  const shipmentWaiting = byStatus[STATUSES.SHIPMENT_WAITING] || 0;

  const recentAlerts = db.prepare(`SELECT a.*, c.model_name FROM alerts a LEFT JOIN cars c ON c.car_id=a.car_id WHERE a.occurred_at >= ?${aScope.sql} ORDER BY a.occurred_at DESC LIMIT 10`).all(shiftStart, ...aScope.params);

  const inspectingStatuses = [STATUSES.BATTERY_INSPECTION, STATUSES.CELL_INSPECTION, STATUSES.RE_INSPECTION];
  const anomalyStatuses = [STATUSES.ANOMALY_DETECTED, STATUSES.QA_MAINTENANCE];
  const carCols = `SELECT car_id, model_name, current_status, updated_at FROM cars WHERE created_at >= ?${fScope.sql} AND current_status`;
  const inspectingCars = db.prepare(
    `${carCols} IN (${inspectingStatuses.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 30`
  ).all(shiftStart, ...fParams, ...inspectingStatuses);
  const anomalyCars = db.prepare(
    `${carCols} IN (${anomalyStatuses.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 30`
  ).all(shiftStart, ...fParams, ...anomalyStatuses);
  const arrivalCars = db.prepare(`${carCols}=? ORDER BY updated_at DESC LIMIT 30`).all(shiftStart, ...fParams, STATUSES.ARRIVAL);
  const reInspWaitCars = db.prepare(`${carCols}=? ORDER BY updated_at DESC LIMIT 30`).all(shiftStart, ...fParams, STATUSES.RE_INSPECTION_WAITING);
  const qcCompleteCars = db.prepare(`${carCols}=? ORDER BY updated_at DESC LIMIT 30`).all(shiftStart, ...fParams, STATUSES.BATTERY_QC_COMPLETE);
  const shipWaitingCars = db.prepare(`${carCols}=? ORDER BY updated_at DESC LIMIT 30`).all(shiftStart, ...fParams, STATUSES.SHIPMENT_WAITING);

  const enriched = {
    inspectingCars: enrichCars(inspectingCars),
    anomalyCars: enrichCars(anomalyCars),
    arrivalCars: enrichCars(arrivalCars),
    reInspWaitCars: enrichCars(reInspWaitCars),
    qcCompleteCars: enrichCars(qcCompleteCars),
    shipWaitingCars: enrichCars(shipWaitingCars),
  };

  res.json({
    total, byStatus, openAlerts, recentAlerts,
    inspecting, anomalies, arrival, reInspectionWaiting, qcComplete, shipmentWaiting, shipped,
    ...enriched,
    shiftStart, shiftEnd, durationMin,
  });
});

function enrichCars(cars) {
  if (!cars.length) return cars;
  const carIds = cars.map(c => c.car_id);
  const ph = carIds.map(() => '?').join(',');

  const measurements = db.prepare(`
    SELECT c.car_id, bm.soc, bm.soh, bm.sop, bm.avg_voltage, bm.avg_temperature
    FROM cars c
    JOIN batteries b ON b.car_id = c.car_id
    JOIN battery_measurements bm ON bm.measurement_id = (
      SELECT measurement_id FROM battery_measurements
      WHERE battery_id = b.battery_id
      ORDER BY inspected_at DESC, measurement_id DESC
      LIMIT 1
    )
    WHERE c.car_id IN (${ph})
  `).all(...carIds);

  const steps = db.prepare(`
    SELECT car_id, step_name, step_status
    FROM process_step_histories
    WHERE car_id IN (${ph})
    AND process_history_id IN (
      SELECT MAX(process_history_id) FROM process_step_histories
      WHERE car_id IN (${ph})
      GROUP BY car_id, step_name
    )
  `).all(...carIds, ...carIds);

  const measureMap = Object.fromEntries(measurements.map(m => [m.car_id, m]));
  const stepMap = {};
  steps.forEach(s => {
    if (!stepMap[s.car_id]) stepMap[s.car_id] = {};
    stepMap[s.car_id][s.step_name] = s.step_status;
  });

  return cars.map(c => ({
    ...c,
    measurement: measureMap[c.car_id] || null,
    steps: stepMap[c.car_id] || {},
  }));
}

export default router;

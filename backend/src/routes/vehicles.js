import { Router } from 'express';
import { db, nowISO } from '../db/index.js';
import { authAndScope, authRequired, adminOnly } from '../middleware/auth.js';
import { resolveAlertAndReinspect } from '../services/simulation.js';
import { factoryScopeClause, intersectFactoryIds, parseFactoryIdsParam } from '../db/factoryScope.js';
import { createVehicle } from '../services/vehicleFactory.js';
import { STATUSES } from '../services/constants.js';

const router = Router();

const DATE_FIELD_MAP = {
  updated_at: 'c.current_status_updated_at',
  production_date: 'c.production_date',
  created_at: 'c.created_at',
};

router.get('/facets', ...authAndScope, (req, res) => {
  const scope = factoryScopeClause(req.allowedFactoryIds, 'factory_id');
  const baseWhere = `WHERE 1=1${scope.sql}`;
  const models = db.prepare(`SELECT DISTINCT model_name FROM cars ${baseWhere} AND model_name IS NOT NULL ORDER BY model_name`).all(...scope.params).map(r => r.model_name);
  const countries = db.prepare(`SELECT DISTINCT destination_country FROM cars ${baseWhere} AND destination_country IS NOT NULL ORDER BY destination_country`).all(...scope.params).map(r => r.destination_country);
  res.json({ models, countries });
});

router.get('/', ...authAndScope, (req, res) => {
  const {
    status, q, country, factory_id, factory_ids,
    car_id, model, date_field, date_from, date_to, match_mode,
  } = req.query;

  // factory_id / factory_ids 둘 다 권한과 교집합
  let requested = parseFactoryIdsParam(factory_ids);
  if (factory_id) {
    const single = parseInt(factory_id, 10);
    if (Number.isInteger(single)) requested = (requested || []).concat(single);
  }
  const effective = intersectFactoryIds(requested, req.allowedFactoryIds);
  if (effective.length === 0) return res.json({ items: [] });
  const fScope = factoryScopeClause(effective, 'c.factory_id');

  let sql = `SELECT c.*, f.factory_name FROM cars c LEFT JOIN factories f ON f.factory_id=c.factory_id WHERE 1=1${fScope.sql}`;
  const params = [...fScope.params];

  const parseCSV = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const condParts = [];
  const condParams = [];
  const addIn = (col, values) => {
    if (!values.length) return;
    condParts.push(`${col} IN (${values.map(() => '?').join(',')})`);
    condParams.push(...values);
  };
  if (car_id) { condParts.push('c.car_id LIKE ?'); condParams.push(`%${car_id}%`); }
  if (q) { condParts.push('(c.car_id LIKE ? OR c.model_name LIKE ?)'); condParams.push(`%${q}%`, `%${q}%`); }
  addIn('c.current_status', parseCSV(status));
  addIn('c.destination_country', parseCSV(country));
  addIn('c.model_name', parseCSV(model));
  const dateCol = DATE_FIELD_MAP[date_field] || DATE_FIELD_MAP.updated_at;
  if (date_from) {
    const s = String(date_from).replace('T', ' ');
    condParts.push(`${dateCol} >= ?`);
    condParams.push(s.split(':').length === 3 ? s : `${s}:00`);
  }
  if (date_to) {
    const s = String(date_to).replace('T', ' ');
    condParts.push(`${dateCol} <= ?`);
    condParams.push(s.split(':').length === 3 ? s : `${s}:59`);
  }

  if (condParts.length) {
    const op = match_mode === 'or' ? ' OR ' : ' AND ';
    sql += ' AND (' + condParts.join(op) + ')';
    params.push(...condParams);
  }

  sql += ' ORDER BY c.updated_at DESC LIMIT 500';
  res.json({ items: db.prepare(sql).all(...params) });
});

const FAIL_KEYS = ['soc', 'soh', 'sop', 'pack_voltage', 'avg_temperature', 'cell_temperature', 'cell_voltage'];

router.post('/', authRequired, adminOnly, (req, res) => {
  const { model_name, destination_country, factory_id, fail_metrics } = req.body || {};
  if (!factory_id || !Number.isInteger(Number(factory_id))) {
    return res.status(400).json({ error: '공장을 선택하세요.' });
  }
  const factory = db.prepare('SELECT factory_id FROM factories WHERE factory_id=? AND is_active=1').get(Number(factory_id));
  if (!factory) return res.status(400).json({ error: '유효한 공장이 아닙니다.' });

  const failMetrics = {};
  if (fail_metrics && typeof fail_metrics === 'object') {
    for (const k of FAIL_KEYS) if (fail_metrics[k]) failMetrics[k] = true;
  }

  try {
    const { carId } = createVehicle({
      initialStatus: STATUSES.ARRIVAL,
      modelName: (model_name || '').trim() || undefined,
      destinationCountry: (destination_country || '').trim() || undefined,
      factoryIdOverride: factory.factory_id,
      failMetrics,
    });
    res.json({ car_id: carId });
  } catch (e) {
    res.status(500).json({ error: '차량 생성 실패', detail: String(e.message || e) });
  }
});

router.put('/:carId', authRequired, adminOnly, (req, res) => {
  const carId = req.params.carId;
  const car = db.prepare('SELECT car_id FROM cars WHERE car_id=?').get(carId);
  if (!car) return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });

  const { model_name, destination_country, factory_id } = req.body || {};
  const updates = [];
  const params = [];
  if (model_name !== undefined) {
    const v = String(model_name).trim();
    if (!v) return res.status(400).json({ error: '모델명은 비울 수 없습니다.' });
    updates.push('model_name=?'); params.push(v);
  }
  if (destination_country !== undefined) {
    const v = String(destination_country).trim();
    if (!v) return res.status(400).json({ error: '수출국은 비울 수 없습니다.' });
    updates.push('destination_country=?'); params.push(v);
  }
  if (factory_id !== undefined) {
    const fid = Number(factory_id);
    if (!Number.isInteger(fid)) return res.status(400).json({ error: '유효한 공장이 아닙니다.' });
    const factory = db.prepare('SELECT factory_id FROM factories WHERE factory_id=? AND is_active=1').get(fid);
    if (!factory) return res.status(400).json({ error: '유효한 공장이 아닙니다.' });
    updates.push('factory_id=?'); params.push(fid);
  }
  if (!updates.length) return res.json({ ok: true });
  updates.push('updated_at=?'); params.push(nowISO());
  params.push(carId);
  db.prepare(`UPDATE cars SET ${updates.join(', ')} WHERE car_id=?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:carId', authRequired, adminOnly, (req, res) => {
  const carId = req.params.carId;
  const car = db.prepare('SELECT car_id FROM cars WHERE car_id=?').get(carId);
  if (!car) return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM alert_status_histories WHERE alert_id IN (SELECT alert_id FROM alerts WHERE car_id=?)').run(carId);
    db.prepare('DELETE FROM alerts WHERE car_id=?').run(carId);
    const battery = db.prepare('SELECT battery_id FROM batteries WHERE car_id=?').get(carId);
    if (battery) {
      db.prepare('DELETE FROM battery_cell_measurements WHERE cell_id IN (SELECT cell_id FROM battery_cells WHERE battery_id=?)').run(battery.battery_id);
      db.prepare('DELETE FROM battery_cells WHERE battery_id=?').run(battery.battery_id);
      db.prepare('DELETE FROM battery_measurements WHERE battery_id=?').run(battery.battery_id);
      db.prepare('DELETE FROM batteries WHERE battery_id=?').run(battery.battery_id);
    }
    db.prepare('DELETE FROM inspection_results WHERE car_id=?').run(carId);
    db.prepare('DELETE FROM process_step_histories WHERE car_id=?').run(carId);
    db.prepare('DELETE FROM car_status_histories WHERE car_id=?').run(carId);
    db.prepare('DELETE FROM vehicle_generation_logs WHERE car_id=?').run(carId);
    db.prepare('DELETE FROM cars WHERE car_id=?').run(carId);
  });
  try {
    tx();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '차량 삭제 실패', detail: String(e.message || e) });
  }
});

router.get('/:carId', ...authAndScope, (req, res) => {
  const carId = req.params.carId;
  const car = db.prepare(`SELECT c.*, f.factory_name FROM cars c LEFT JOIN factories f ON f.factory_id=c.factory_id WHERE c.car_id=?`).get(carId);
  if (!car) return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });
  // 권한 외 공장 차량은 존재 사실도 누설 안 함 — 동일한 404
  if (!req.allowedFactoryIds.includes(car.factory_id)) {
    return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });
  }
  const battery = db.prepare('SELECT * FROM batteries WHERE car_id=?').get(carId);
  const measurement = battery ? db.prepare('SELECT * FROM battery_measurements WHERE battery_id=? ORDER BY inspected_at DESC LIMIT 1').get(battery.battery_id) : null;
  const cells = battery ? db.prepare(`
    SELECT bc.cell_id, bc.cell_number, bcm.cell_temperature, bcm.cell_voltage, bcm.measured_at
    FROM battery_cells bc
    LEFT JOIN battery_cell_measurements bcm ON bcm.cell_measurement_id = (
      SELECT MAX(cell_measurement_id) FROM battery_cell_measurements WHERE cell_id=bc.cell_id
    )
    WHERE bc.battery_id=? ORDER BY bc.cell_number`).all(battery.battery_id) : [];
  const steps = db.prepare('SELECT * FROM process_step_histories WHERE car_id=? ORDER BY process_history_id').all(carId);
  const statusHistory = db.prepare('SELECT * FROM car_status_histories WHERE car_id=? ORDER BY car_status_history_id DESC LIMIT 30').all(carId);
  const alerts = db.prepare('SELECT * FROM alerts WHERE car_id=? ORDER BY occurred_at DESC').all(carId);
  res.json({ car, battery, measurement, cells, steps, statusHistory, alerts });
});

router.post('/:carId/resolve', ...authAndScope, (req, res) => {
  const car = db.prepare('SELECT factory_id FROM cars WHERE car_id=?').get(req.params.carId);
  if (!car || !req.allowedFactoryIds.includes(car.factory_id)) {
    return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });
  }
  const ok = resolveAlertAndReinspect(req.params.carId, req.user.uid);
  if (!ok) return res.status(404).json({ error: '차량을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

export default router;

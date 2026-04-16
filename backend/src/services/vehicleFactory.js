import { db, nowISO } from '../db/index.js';
import { MODELS, STATUSES, FACTORY_MODELS } from './constants.js';
import { genMetric } from './random.js';

let seq = 0;

function carIdForToday(n) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `VH-${y}${m}${day}-${String(n).padStart(4, '0')}`;
}

function pickFactory() {
  const rows = db.prepare('SELECT factory_id, factory_name FROM factories WHERE is_active=1').all();
  return rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
}
function pickCountry() {
  const rows = db.prepare('SELECT country_name FROM countries WHERE is_allowed=1').all();
  return rows.length ? rows[Math.floor(Math.random() * rows.length)].country_name : '에버랜드';
}
function pickModel(factoryName) {
  const list = (factoryName && FACTORY_MODELS[factoryName]) || MODELS;
  return list[Math.floor(Math.random() * list.length)];
}

function nextSeq() {
  seq += 1;
  return seq;
}

export function createVehicle({
  initialStatus = STATUSES.ARRIVAL,
  forceAbnormal = false,
  seqOverride,
  modelName,
  destinationCountry,
  factoryIdOverride,
  failMetrics = {},
} = {}) {
  const now = nowISO();
  const carId = carIdForToday(seqOverride || nextSeq());
  const country = destinationCountry || pickCountry();
  const factory = factoryIdOverride
    ? db.prepare('SELECT factory_id, factory_name FROM factories WHERE factory_id=? AND is_active=1').get(factoryIdOverride)
    : pickFactory();
  const factoryId = factory ? factory.factory_id : null;
  const model = modelName || pickModel(factory && factory.factory_name);
  const today = now.slice(0, 10);

  db.prepare(`INSERT INTO cars (car_id,model_name,production_date,destination_country,factory_id,current_status,current_status_updated_at,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(carId, model, today, country, factoryId, initialStatus, now, now, now);

  db.prepare('INSERT INTO car_status_histories (car_id,status,changed_at,reason) VALUES (?,?,?,?)').run(carId, initialStatus, now, '최초 입고');

  const batteryInfo = db.prepare('INSERT INTO batteries (car_id,battery_serial_number,manufacture_date,installed_at) VALUES (?,?,?,?)')
    .run(carId, `BSN-${carId}`, today, now);
  const batteryId = batteryInfo.lastInsertRowid;

  // Create 100 cells
  const cellStmt = db.prepare('INSERT INTO battery_cells (battery_id,cell_number) VALUES (?,?)');
  const cellIds = [];
  for (let i = 1; i <= 100; i += 1) {
    const res = cellStmt.run(batteryId, i);
    cellIds.push(res.lastInsertRowid);
  }

  // Initial measurements — forceAbnormal은 soc 하나만 실패시키던 기존 동작 유지,
  // failMetrics는 관리자 UI에서 지표별로 실패 여부를 명시적으로 지정.
  const soc = genMetric('soc', { forceAbnormal: !!failMetrics.soc || forceAbnormal });
  const soh = genMetric('soh', { forceAbnormal: !!failMetrics.soh });
  const sop = genMetric('sop', { forceAbnormal: !!failMetrics.sop });
  const packV = genMetric('pack_voltage', { forceAbnormal: !!failMetrics.pack_voltage });
  const avgT = genMetric('cell_temperature', { forceAbnormal: !!failMetrics.avg_temperature });
  const tempDev = +(Math.random() * 2).toFixed(2);
  db.prepare(`INSERT INTO battery_measurements (battery_id,inspected_at,soc,soh,sop,avg_voltage,avg_temperature,temperature_deviation)
              VALUES (?,?,?,?,?,?,?,?)`).run(batteryId, now, soc, soh, sop, packV, avgT, tempDev);

  // 특정 셀 하나를 실패시키는 기존 패턴 유지 — cell_temperature/cell_voltage 지정 시 같은 셀에서 발생
  const cellFailAny = !!failMetrics.cell_temperature || !!failMetrics.cell_voltage;
  const abnormalCellIdx = (cellFailAny || forceAbnormal) ? Math.floor(Math.random() * 100) : -1;
  const cellMeasStmt = db.prepare('INSERT INTO battery_cell_measurements (cell_id,measured_at,cell_temperature,cell_voltage) VALUES (?,?,?,?)');
  cellIds.forEach((cid, idx) => {
    const bad = idx === abnormalCellIdx;
    const failCellT = bad && (!!failMetrics.cell_temperature || (forceAbnormal && Math.random() < 0.5));
    const failCellV = bad && (!!failMetrics.cell_voltage || forceAbnormal);
    const t = genMetric('cell_temperature', { forceAbnormal: failCellT });
    const v = genMetric('cell_voltage', { forceAbnormal: failCellV });
    cellMeasStmt.run(cid, now, t, v);
  });

  const genMethod = (modelName || destinationCountry || factoryIdOverride || Object.keys(failMetrics).length) ? 'MANUAL' : 'AUTO';
  db.prepare('INSERT INTO vehicle_generation_logs (car_id,generated_at,generation_method) VALUES (?,?,?)').run(carId, now, genMethod);

  return { carId, batteryId };
}

export function initSeqFromDb() {
  const prefix = (() => {
    const d = new Date();
    return `VH-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-`;
  })();
  const row = db.prepare("SELECT car_id FROM cars WHERE car_id LIKE ? ORDER BY car_id DESC LIMIT 1").get(`${prefix}%`);
  if (row) {
    const tail = row.car_id.split('-').pop();
    seq = parseInt(tail, 10) || 0;
  }
}

import { Router } from 'express';
import { db } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function nowISO() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function factoryClause(ids, col) {
  if (!ids || ids.length === 0) return { sql: ' AND 1=0', params: [] };
  const ph = ids.map(() => '?').join(',');
  return { sql: ` AND ${col} IN (${ph})`, params: ids };
}

router.get('/unresolved-count', (req, res) => {
  const { uid, role } = req.user;
  const allowed = role === 'admin'
    ? db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id)
    : db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(uid).map(r => r.factory_id);
  const { sql, params } = factoryClause(allowed, 'c.factory_id');
  const row = db.prepare(`SELECT COUNT(*) as c FROM alerts a JOIN cars c ON c.car_id=a.car_id WHERE a.current_status!='RESOLVED'${sql}`).get(...params);
  res.json({ count: row.c });
});

router.get('/facets', (req, res) => {
  const { uid, role } = req.user;
  const allowed = role === 'admin'
    ? db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id)
    : db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(uid).map(r => r.factory_id);
  const { sql: sc, params: pc } = factoryClause(allowed, 'c.factory_id');
  const { sql: sf, params: pf } = factoryClause(allowed, 'factory_id');
  const types = db.prepare(`SELECT DISTINCT a.alert_type FROM alerts a JOIN cars c ON c.car_id=a.car_id WHERE a.alert_type IS NOT NULL${sc} ORDER BY a.alert_type`).all(...pc).map(r => r.alert_type);
  const models = db.prepare(`SELECT DISTINCT model_name FROM cars WHERE model_name IS NOT NULL${sf} ORDER BY model_name`).all(...pf).map(r => r.model_name);
  const countries = db.prepare(`SELECT DISTINCT destination_country FROM cars WHERE destination_country IS NOT NULL${sf} ORDER BY destination_country`).all(...pf).map(r => r.destination_country);
  res.json({ alert_types: types, models, countries });
});

router.get('/', (req, res) => {
  const { uid, role } = req.user;
  const q = req.query;
  const allowed = role === 'admin'
    ? db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id)
    : db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(uid).map(r => r.factory_id);
  if (!allowed.length) return res.json({ items: [] });

  const { sql: fs, params: fp } = factoryClause(allowed, 'c.factory_id');
  let sql = `SELECT a.*, c.model_name, c.destination_country, c.factory_id FROM alerts a LEFT JOIN cars c ON c.car_id=a.car_id WHERE 1=1${fs}`;
  const params = [...fp];
  const parts = [];

  if (q.car_id) { parts.push('a.car_id LIKE ?'); params.push(`%${q.car_id}%`); }
  for (const [col, key] of [['a.current_status','status'],['a.severity','severity'],['a.alert_type','alert_type'],['c.model_name','model'],['c.destination_country','country']]) {
    if (q[key]) { const vals = q[key].split(',').filter(Boolean); if (vals.length) { parts.push(`${col} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); } }
  }
  const dateCol = q.date_field === 'resolved_at' ? 'a.resolved_at' : 'a.occurred_at';
  if (q.date_from) { parts.push(`${dateCol} >= ?`); params.push(q.date_from.replace('T', ' ')); }
  if (q.date_to) { parts.push(`${dateCol} <= ?`); params.push(q.date_to.replace('T', ' ')); }
  if (parts.length) sql += ` AND (${parts.join(q.match_mode === 'or' ? ' OR ' : ' AND ')})`;
  sql += ' ORDER BY a.occurred_at DESC LIMIT 500';

  res.json({ items: db.prepare(sql).all(...params) });
});

router.post('/:alertId/acknowledge', (req, res) => {
  const { uid } = req.user;
  const alertId = Number(req.params.alertId);
  const row = db.prepare('SELECT a.*, c.factory_id FROM alerts a LEFT JOIN cars c ON c.car_id=a.car_id WHERE a.alert_id=?').get(alertId);
  if (!row) return res.status(404).json({ error: '경보를 찾을 수 없습니다.' });
  const now = nowISO();
  db.prepare("UPDATE alerts SET current_status='ACKNOWLEDGED' WHERE alert_id=?").run(alertId);
  db.prepare('INSERT INTO alert_status_histories (alert_id,previous_status,new_status,changed_by_user_id,changed_at,note) VALUES (?,?,?,?,?,?)').run(alertId, row.current_status, 'ACKNOWLEDGED', uid, now, '확인');
  res.json({ ok: true });
});

router.post('/bulk-delete', (req, res) => {
  const { role } = req.user;
  if (role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  const ids = (req.body.alert_ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: '선택된 경보가 없습니다.' });
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM alert_status_histories WHERE alert_id IN (${ph})`).run(...ids);
  const deleted = db.prepare(`DELETE FROM alerts WHERE alert_id IN (${ph})`).run(...ids).changes;
  res.json({ ok: true, deleted });
});

router.post('/:alertId/resolve', (req, res) => {
  const { uid } = req.user;
  const alertId = Number(req.params.alertId);
  const row = db.prepare('SELECT a.*, c.factory_id FROM alerts a LEFT JOIN cars c ON c.car_id=a.car_id WHERE a.alert_id=?').get(alertId);
  if (!row) return res.status(404).json({ error: '경보를 찾을 수 없습니다.' });
  const now = nowISO();
  db.prepare("UPDATE alerts SET current_status='RESOLVED', resolved_at=? WHERE alert_id=?").run(now, alertId);
  db.prepare('INSERT INTO alert_status_histories (alert_id,previous_status,new_status,changed_by_user_id,changed_at,note) VALUES (?,?,?,?,?,?)').run(alertId, row.current_status, 'RESOLVED', uid, now, '해결');
  res.json({ ok: true });
});

export default router;

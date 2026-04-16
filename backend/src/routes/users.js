import { Router } from 'express';
import { db } from '../db/index.js';
import { authRequired, adminOnly } from '../middleware/auth.js';

const router = Router();

router.get('/', authRequired, adminOnly, (req, res) => {
  const items = db.prepare(
    'SELECT user_id, email, role, name, created_at FROM users ORDER BY created_at DESC'
  ).all();
  // 사용자별 공장 매핑 개수 함께 반환 (UI에서 N/total 표시용)
  const counts = db.prepare('SELECT user_id, COUNT(*) AS c FROM user_factories GROUP BY user_id').all();
  const countMap = Object.fromEntries(counts.map(r => [r.user_id, r.c]));
  res.json({ items: items.map(u => ({ ...u, factory_count: countMap[u.user_id] || 0 })) });
});

router.put('/:user_id/role', authRequired, adminOnly, (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const { role } = req.body || {};
  if (!['admin', 'operator'].includes(role)) {
    return res.status(400).json({ error: '유효하지 않은 역할입니다.' });
  }
  if (userId === req.user.uid) {
    return res.status(400).json({ error: '본인의 역할은 변경할 수 없습니다.' });
  }
  const target = db.prepare('SELECT user_id, role, email FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === role) {
    return res.status(400).json({ error: '이미 해당 역할입니다.' });
  }
  if (target.role === 'admin' && role === 'operator') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '마지막 관리자는 강등할 수 없습니다.' });
    }
  }
  db.prepare('UPDATE users SET role=? WHERE user_id=?').run(role, userId);
  // 역할 전환 시 user_factories 정리 — 강등/승격 모두 0개로 시작 (예측 가능한 secure default)
  db.prepare('DELETE FROM user_factories WHERE user_id=?').run(userId);
  console.log(`[USERS] ${req.user.email} → ${target.email}: role ${target.role} → ${role} (factories cleared)`);
  res.json({ ok: true });
});

router.delete('/:user_id', authRequired, adminOnly, (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  if (userId === req.user.uid) {
    return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
  }
  const target = db.prepare('SELECT role, email FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '마지막 관리자는 삭제할 수 없습니다.' });
    }
  }
  // user_factories는 FK CASCADE로 자동 삭제되지만, foreign_keys PRAGMA가 꺼진 경우 대비해 명시적으로 정리
  db.prepare('DELETE FROM user_factories WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM users WHERE user_id=?').run(userId);
  console.log(`[USERS] ${req.user.email} deleted ${target.email}`);
  res.json({ ok: true });
});

router.get('/:user_id/factories', authRequired, adminOnly, (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const target = db.prepare('SELECT user_id, role FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const factory_ids = db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(userId).map(r => r.factory_id);
  res.json({ factory_ids, role: target.role });
});

router.put('/:user_id/factories', authRequired, adminOnly, (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const { factory_ids } = req.body || {};
  if (!Array.isArray(factory_ids)) {
    return res.status(400).json({ error: 'factory_ids 배열이 필요합니다.' });
  }
  const target = db.prepare('SELECT user_id, role, email FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === 'admin') {
    return res.status(400).json({ error: '관리자는 별도 공장 매핑이 필요하지 않습니다 (전체 접근).' });
  }

  const cleanIds = factory_ids
    .map(v => parseInt(v, 10))
    .filter(Number.isInteger);
  // 입력된 모든 ID가 실제 존재하는 공장인지 확인
  if (cleanIds.length > 0) {
    const placeholders = cleanIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT factory_id FROM factories WHERE factory_id IN (${placeholders})`).all(...cleanIds);
    if (found.length !== new Set(cleanIds).size) {
      return res.status(400).json({ error: '존재하지 않는 공장 ID가 포함되어 있습니다.' });
    }
  }

  const tx = db.transaction((uid, ids) => {
    db.prepare('DELETE FROM user_factories WHERE user_id=?').run(uid);
    const ins = db.prepare('INSERT INTO user_factories (user_id, factory_id) VALUES (?, ?)');
    [...new Set(ids)].forEach(fid => ins.run(uid, fid));
  });
  tx(userId, cleanIds);
  console.log(`[USERS] ${req.user.email} updated factories of ${target.email}: [${cleanIds.join(',')}]`);
  res.json({ ok: true, factory_ids: cleanIds });
});

export default router;

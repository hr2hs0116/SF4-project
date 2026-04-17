import { Router } from 'express';
import { db } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function adminOnly(req, res) {
  if (req.user.role !== 'admin') { res.status(403).json({ error: '관리자 권한이 필요합니다.' }); return false; }
  return true;
}

router.get('/', (req, res) => {
  if (!adminOnly(req, res)) return;
  const items = db.prepare('SELECT user_id, email, role, name, created_at FROM users ORDER BY created_at DESC').all();
  const counts = db.prepare('SELECT user_id, COUNT(*) as c FROM user_factories GROUP BY user_id').all();
  const countMap = Object.fromEntries(counts.map(r => [r.user_id, r.c]));
  res.json({ items: items.map(u => ({ ...u, factory_count: countMap[u.user_id] || 0 })) });
});

router.put('/:userId/role', (req, res) => {
  if (!adminOnly(req, res)) return;
  const userId = Number(req.params.userId);
  const { role } = req.body;
  if (!['admin', 'operator'].includes(role)) return res.status(400).json({ error: '유효하지 않은 역할입니다.' });
  if (userId === req.user.uid) return res.status(400).json({ error: '본인의 역할은 변경할 수 없습니다.' });
  const target = db.prepare('SELECT role FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === role) return res.status(400).json({ error: '이미 해당 역할입니다.' });
  if (target.role === 'admin' && role === 'operator') {
    const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '마지막 관리자는 강등할 수 없습니다.' });
  }
  db.prepare('UPDATE users SET role=? WHERE user_id=?').run(role, userId);
  db.prepare('DELETE FROM user_factories WHERE user_id=?').run(userId);
  res.json({ ok: true });
});

router.delete('/:userId', (req, res) => {
  if (!adminOnly(req, res)) return;
  const userId = Number(req.params.userId);
  if (userId === req.user.uid) return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
  const target = db.prepare('SELECT role FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '마지막 관리자는 삭제할 수 없습니다.' });
  }
  db.prepare('DELETE FROM user_factories WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM users WHERE user_id=?').run(userId);
  res.json({ ok: true });
});

router.get('/:userId/factories', (req, res) => {
  if (!adminOnly(req, res)) return;
  const userId = Number(req.params.userId);
  const user = db.prepare('SELECT user_id, role FROM users WHERE user_id=?').get(userId);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const factoryIds = db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(userId).map(r => r.factory_id);
  res.json({ factory_ids: factoryIds, role: user.role });
});

router.put('/:userId/factories', (req, res) => {
  if (!adminOnly(req, res)) return;
  const userId = Number(req.params.userId);
  const rawList = req.body.factory_ids;
  if (!Array.isArray(rawList)) return res.status(400).json({ error: 'factory_ids 배열이 필요합니다.' });
  const target = db.prepare('SELECT role FROM users WHERE user_id=?').get(userId);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (target.role === 'admin') return res.status(400).json({ error: '관리자는 별도 공장 매핑이 필요하지 않습니다.' });
  const cleanIds = [...new Set(rawList.map(Number).filter(Boolean))];
  if (cleanIds.length > 0) {
    const ph = cleanIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT factory_id FROM factories WHERE factory_id IN (${ph})`).all(...cleanIds);
    if (found.length !== cleanIds.length) return res.status(400).json({ error: '존재하지 않는 공장 ID가 포함되어 있습니다.' });
  }
  db.prepare('DELETE FROM user_factories WHERE user_id=?').run(userId);
  const ins = db.prepare('INSERT INTO user_factories (user_id, factory_id) VALUES (?, ?)');
  for (const fid of cleanIds) ins.run(userId, fid);
  res.json({ ok: true, factory_ids: cleanIds });
});

export default router;

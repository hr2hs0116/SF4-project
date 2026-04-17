import { Router } from 'express';
import { db, nowISO } from '../db/index.js';
import { authRequired, adminOnly, authAndScope } from '../middleware/auth.js';
import { listSettings, setSetting } from '../services/settings.js';

const router = Router();

router.get('/', authRequired, (req, res) => {
  res.json({ items: listSettings() });
});

router.put('/:key', authRequired, adminOnly, (req, res) => {
  const key = req.params.key;
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value 필수' });
  const exists = db.prepare('SELECT 1 FROM admin_settings WHERE setting_key=?').get(key);
  if (!exists) return res.status(404).json({ error: '설정 키 없음' });
  setSetting(key, value, req.user.uid);
  res.json({ ok: true });
});

router.get('/countries', authRequired, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM countries ORDER BY country_name').all() });
});

router.put('/countries/:id', authRequired, adminOnly, (req, res) => {
  const { is_allowed } = req.body || {};
  db.prepare('UPDATE countries SET is_allowed=? WHERE country_id=?').run(is_allowed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.get('/factories', ...authAndScope, (req, res) => {
  // 권한 있는 공장만 반환 (admin은 미들웨어가 모든 공장으로 채워줌)
  const allowed = req.allowedFactoryIds;
  if (!allowed || allowed.length === 0) return res.json({ items: [] });
  const placeholders = allowed.map(() => '?').join(',');
  res.json({ items: db.prepare(`
    SELECT * FROM factories WHERE factory_id IN (${placeholders}) ORDER BY
      CASE factory_name
        WHEN '청림공장' THEN 1
        WHEN '은하공장' THEN 2
        WHEN '백운공장' THEN 3
        WHEN '단풍공장' THEN 4
        WHEN '태양공장' THEN 5
        WHEN '한빛공장' THEN 6
        ELSE 99
      END
  `).all(...allowed) });
});

// 관리자 전용: 모든 활성 공장 (사용자별 권한 부여 UI에서 사용)
router.get('/factories/all', authRequired, adminOnly, (req, res) => {
  res.json({ items: db.prepare(`
    SELECT * FROM factories WHERE is_active=1 ORDER BY
      CASE factory_name
        WHEN '청림공장' THEN 1
        WHEN '은하공장' THEN 2
        WHEN '백운공장' THEN 3
        WHEN '단풍공장' THEN 4
        WHEN '태양공장' THEN 5
        WHEN '한빛공장' THEN 6
        ELSE 99
      END
  `).all() });
});

router.get('/llm/models', authRequired, async (_req, res) => {
  const baseURL = process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  try {
    const r = await fetch(`${baseURL}/v1/models`);
    if (!r.ok) return res.status(502).json({ error: 'LM Studio 응답 오류', items: [] });
    const data = await r.json();
    const items = (data?.data || []).map(m => ({ id: m.id }));
    res.json({ items });
  } catch (e) {
    res.status(502).json({ error: 'LM Studio에 연결할 수 없습니다.', detail: String(e.message || e), items: [] });
  }
});

export default router;

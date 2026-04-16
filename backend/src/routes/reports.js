import { Router } from 'express';
import { db } from '../db/index.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();

// 리포트 목록 — 본인 것만 (작성자 외에는 공유 불가)
router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT report_id, title, summary, source_session_id, llm_mode, llm_model,
           message_count, car_ids, created_at
    FROM reports
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(req.user.uid);
  const items = rows.map(r => ({
    ...r,
    car_ids: r.car_ids ? JSON.parse(r.car_ids) : [],
  }));
  res.json({ items });
});

// 리포트 상세 — 본인 것만
router.get('/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID' });
  const row = db.prepare(`
    SELECT report_id, user_id, title, summary, content, source_session_id,
           llm_mode, llm_model, message_count, car_ids, created_at
    FROM reports
    WHERE report_id=?
  `).get(id);
  if (!row) return res.status(404).json({ error: '리포트를 찾을 수 없습니다' });
  if (row.user_id !== req.user.uid) {
    return res.status(403).json({ error: '본인이 작성한 리포트만 조회할 수 있습니다' });
  }
  let content;
  try { content = JSON.parse(row.content); } catch { content = { messages: [] }; }
  res.json({
    ...row,
    content,
    car_ids: row.car_ids ? JSON.parse(row.car_ids) : [],
  });
});

// 리포트 삭제 — 본인 것만
router.delete('/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 ID' });
  const row = db.prepare('SELECT user_id FROM reports WHERE report_id=?').get(id);
  if (!row) return res.status(404).json({ error: '리포트를 찾을 수 없습니다' });
  if (row.user_id !== req.user.uid) {
    return res.status(403).json({ error: '본인이 작성한 리포트만 삭제할 수 있습니다' });
  }
  db.prepare('DELETE FROM reports WHERE report_id=?').run(id);
  res.json({ ok: true });
});

export default router;

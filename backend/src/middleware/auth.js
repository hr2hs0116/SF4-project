import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';

const SECRET = process.env.JWT_SECRET || 'bms-sf-secret-change-in-production';

export function signToken(user) {
  return jwt.sign({ uid: user.user_id, role: user.role, email: user.email, name: user.name }, SECRET, { expiresIn: '12h' });
}

export function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '인증이 필요합니다.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '토큰이 유효하지 않습니다.' });
  }
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  next();
}

// 매 요청마다 사용자의 공장 권한을 DB에서 조회해 req에 주입.
// admin은 활성 공장 전체를 자동 부여 → user_factories 테이블을 우회.
export function loadUserFactories(req, res, next) {
  try {
    if (req.user?.role === 'admin') {
      req.allowedFactoryIds = db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id);
      req.isAdminScope = true;
    } else {
      req.allowedFactoryIds = db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(req.user.uid).map(r => r.factory_id);
      req.isAdminScope = false;
    }
    next();
  } catch (e) {
    return res.status(500).json({ error: '공장 권한 조회 실패', detail: String(e.message || e) });
  }
}

// 라우트에서 한 줄로 사용: router.get('/x', ...authAndScope, handler)
export const authAndScope = [authRequired, loadUserFactories];

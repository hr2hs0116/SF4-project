import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'bms-sf-secret-key';

export function signToken(uid, role, email, name) {
  return jwt.sign({ uid, role, email, name }, JWT_SECRET, { expiresIn: '24h' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '인증이 필요합니다.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
}

function attachScope(req, res, next) {
  const { uid, role } = req.user;
  if (role === 'admin') {
    req.allowedFactoryIds = db
      .prepare('SELECT factory_id FROM factories WHERE is_active=1')
      .all()
      .map(r => r.factory_id);
  } else {
    req.allowedFactoryIds = db
      .prepare('SELECT factory_id FROM user_factories WHERE user_id=?')
      .all(uid)
      .map(r => r.factory_id);
  }
  next();
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

export const authAndScope = [requireAuth, attachScope];
export const authRequired = requireAuth;

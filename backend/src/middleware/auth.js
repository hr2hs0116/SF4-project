import jwt from 'jsonwebtoken';

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

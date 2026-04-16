import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { signToken, authRequired, authAndScope } from '../middleware/auth.js';

const router = Router();

function getAllowedFactoryIds(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id);
  }
  return db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(user.user_id).map(r => r.factory_id);
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  const token = signToken(u);
  const allowed_factory_ids = getAllowedFactoryIds(u);
  res.json({
    token,
    user: {
      user_id: u.user_id, email: u.email, role: u.role, name: u.name,
      allowed_factory_ids, is_admin_scope: u.role === 'admin',
    },
  });
});

router.post('/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: '이메일, 비밀번호, 이름을 모두 입력하세요.' });
  }
  const emailTrim = String(email).trim().toLowerCase();
  const nameTrim = String(name).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (String(password).length < 7) {
    return res.status(400).json({ error: '비밀번호는 7자 이상이어야 합니다.' });
  }
  if (!nameTrim || nameTrim.length > 50) {
    return res.status(400).json({ error: '이름은 1~50자로 입력하세요.' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE email=?').get(emailTrim);
  if (exists) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)')
    .run(emailTrim, hash, 'operator', nameTrim);
  const user = { user_id: result.lastInsertRowid, email: emailTrim, role: 'operator', name: nameTrim };
  const token = signToken(user);
  // 신규 가입자는 공장 권한 0개로 시작 (관리자가 명시적으로 부여해야 함)
  res.status(201).json({
    token,
    user: { ...user, allowed_factory_ids: [], is_admin_scope: false },
  });
});

router.get('/me', ...authAndScope, (req, res) => {
  res.json({
    user: {
      ...req.user,
      allowed_factory_ids: req.allowedFactoryIds,
      is_admin_scope: req.isAdminScope,
    },
  });
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/init.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = Router();

function getAllowedFactories(userId, role) {
  if (role === 'admin') {
    return db.prepare('SELECT factory_id FROM factories WHERE is_active=1').all().map(r => r.factory_id);
  }
  return db.prepare('SELECT factory_id FROM user_factories WHERE user_id=?').all(userId).map(r => r.factory_id);
}

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요.' });

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }

  const token = signToken(user.user_id, user.role, user.email, user.name);
  const allowedFactoryIds = getAllowedFactories(user.user_id, user.role);

  res.json({
    token,
    user: {
      user_id: user.user_id,
      email: user.email,
      role: user.role,
      name: user.name,
      allowed_factory_ids: allowedFactoryIds,
      is_admin_scope: user.role === 'admin',
    },
  });
});

router.post('/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: '이메일, 비밀번호, 이름을 모두 입력하세요.' });
  }
  const emailTrim = email.trim().toLowerCase();
  const nameTrim = name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (password.length < 7) return res.status(400).json({ error: '비밀번호는 7자 이상이어야 합니다.' });
  if (!nameTrim || nameTrim.length > 50) return res.status(400).json({ error: '이름은 1~50자로 입력하세요.' });

  const exists = db.prepare('SELECT COUNT(*) as c FROM users WHERE email=?').get(emailTrim).c;
  if (exists > 0) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, ?, ?)').run(emailTrim, hash, 'operator', nameTrim);
  const newId = result.lastInsertRowid;

  const token = signToken(newId, 'operator', emailTrim, nameTrim);
  res.status(201).json({
    token,
    user: { user_id: newId, email: emailTrim, role: 'operator', name: nameTrim, allowed_factory_ids: [], is_admin_scope: false },
  });
});

router.get('/me', requireAuth, (req, res) => {
  const { uid, role, email, name } = req.user;
  const allowedFactoryIds = getAllowedFactories(uid, role);
  res.json({ user: { uid, role, email, name, allowed_factory_ids: allowedFactoryIds, is_admin_scope: role === 'admin' } });
});

export default router;

import { db, nowISO } from '../db/index.js';

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT setting_value, setting_type FROM admin_settings WHERE setting_key=?').get(key);
  if (!row) return fallback;
  if (row.setting_type === 'INTEGER') return parseInt(row.setting_value, 10);
  if (row.setting_type === 'FLOAT') return parseFloat(row.setting_value);
  if (row.setting_type === 'JSON') { try { return JSON.parse(row.setting_value); } catch { return fallback; } }
  return row.setting_value;
}

export function setSetting(key, value, userId) {
  db.prepare('UPDATE admin_settings SET setting_value=?, updated_at=?, updated_by_user_id=? WHERE setting_key=?')
    .run(String(value), nowISO(), userId || null, key);
}

export function listSettings() {
  return db.prepare('SELECT setting_key, setting_value, setting_type, description, updated_at FROM admin_settings').all();
}

/**
 * db/factoryScope.js
 * Utility helpers for factory-scoped SQL queries.
 * Mirrors Java's FactoryScope.java logic.
 */

/**
 * Builds a SQL fragment like ` AND col IN (?,?,?)` with bound params.
 * If ids is empty, returns a clause that matches nothing (AND 1=0).
 */
export function factoryScopeClause(ids, col) {
  if (!ids || ids.length === 0) {
    return { sql: ' AND 1=0', params: [] };
  }
  const ph = ids.map(() => '?').join(',');
  return { sql: ` AND ${col} IN (${ph})`, params: [...ids] };
}

/**
 * Intersects requested factory IDs with the user's allowed IDs.
 * If requested is null/undefined, returns the full allowed list.
 */
export function intersectFactoryIds(requested, allowed) {
  if (!allowed || allowed.length === 0) return [];
  if (!requested || requested.length === 0) return [...allowed];
  return allowed.filter(id => requested.includes(id));
}

/**
 * Parses a comma-separated factory_ids query param into an array of numbers.
 * Returns null if the param is absent or empty.
 */
export function parseFactoryIdsParam(param) {
  if (!param) return null;
  const ids = String(param)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Parses a comma-separated string into a trimmed, non-empty array of strings.
 */
export function parseCsvParam(param) {
  if (!param) return [];
  return String(param).split(',').map(s => s.trim()).filter(Boolean);
}

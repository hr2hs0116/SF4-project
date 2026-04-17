// 공장 권한 헬퍼: WHERE 절 빌더 + 사용자 필터와 권한 교집합 계산.
// 빈 배열일 경우 1=0으로 단락시켜 0건을 자연스럽게 반환.

export function factoryScopeClause(allowedIds, column = 'factory_id') {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) {
    return { sql: ' AND 1=0', params: [] };
  }
  const placeholders = allowedIds.map(() => '?').join(',');
  return { sql: ` AND ${column} IN (${placeholders})`, params: [...allowedIds] };
}

// 사용자가 요청한 factory_ids(필터 바에서 선택한 값)와 권한(allowedIds) 교집합.
// requested가 null/undefined면 권한 전체를 반환.
export function intersectFactoryIds(requested, allowedIds) {
  const allowed = Array.isArray(allowedIds) ? allowedIds : [];
  if (!requested || !Array.isArray(requested) || requested.length === 0) {
    return [...allowed];
  }
  const allowSet = new Set(allowed);
  return requested.filter(id => allowSet.has(id));
}

// 쿼리 문자열 'factory_ids=1,2,3' 파싱 (잘못된 토큰은 버림).
export function parseFactoryIdsParam(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);
  return ids.length ? ids : null;
}

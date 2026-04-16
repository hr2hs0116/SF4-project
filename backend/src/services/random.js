import { getSetting } from './settings.js';
import { RANGES } from './constants.js';

function uniform(min, max) { return Math.random() * (max - min) + min; }
function gaussianInRange(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const mean = (min + max) / 2;
  const std = (max - min) / 6;
  let val = mean + z * std;
  if (val < min) val = min + Math.random() * (max - min) * 0.1;
  if (val > max) val = max - Math.random() * (max - min) * 0.1;
  return val;
}

function abnormalValue(min, max) {
  // Either lower than min or higher than max
  const low = Math.random() < 0.5;
  const span = max - min;
  if (low) return +(min - uniform(0.05 * span, 0.3 * span)).toFixed(3);
  return +(max + uniform(0.05 * span, 0.3 * span)).toFixed(3);
}

function roll(probKey, defaultProb = 99) {
  const prob = getSetting(probKey, defaultProb);
  return Math.random() * 100 <= prob;
}

export function genMetric(kind, { forceAbnormal = false } = {}) {
  const r = RANGES[kind];
  const probKey = `prob_${kind === 'pack_voltage' ? 'pack_voltage' : kind}_normal`;
  const normal = !forceAbnormal && roll(probKey);
  if (normal) return +gaussianInRange(r.min, r.max).toFixed(3);
  return abnormalValue(r.min, r.max);
}

export function isNormal(kind, value) {
  const r = RANGES[kind];
  return value >= r.min && value <= r.max;
}

// 배터리 측정값이 정상 범위에서 얼마나 벗어났는지에 따라 심각도 분류
// 온도/셀전압 상한 이탈은 화재·폭발 직결 위험이라 더 엄격히 평가
const SEVERITY_THRESHOLDS = {
  // key: [LOW(~), MEDIUM(~), HIGH(~), 그 이상 CRITICAL] — 편차 기준(절댓값)
  soc:              { low: 2,    medium: 5,    high: 10 },    // %
  soh:              { low: 2,    medium: 5,    high: 10 },    // %
  sop:              { low: 3,    medium: 8,    high: 15 },    // %
  pack_voltage:     { low: 5,    medium: 15,   high: 30 },    // V
  cell_temperature: { low: 2,    medium: 5,    high: 10 },    // ℃
  cell_voltage:     { low: 0.05, medium: 0.15, high: 0.30 },  // V
};

export function classifySeverity(kind, value) {
  const r = RANGES[kind];
  if (!r) return 'HIGH';
  let delta = 0;
  if (value < r.min) delta = r.min - value;
  else if (value > r.max) delta = value - r.max;
  else return null; // 정상
  const t = SEVERITY_THRESHOLDS[kind];
  if (!t) return 'HIGH';

  // 상한 이탈이 더 위험한 지표(온도·셀전압 과충전)는 한 단계 승격
  const overLimit = value > r.max;
  const escalate = overLimit && (kind === 'cell_temperature' || kind === 'cell_voltage');

  let sev;
  if (delta <= t.low) sev = 'LOW';
  else if (delta <= t.medium) sev = 'MEDIUM';
  else if (delta <= t.high) sev = 'HIGH';
  else sev = 'CRITICAL';

  if (escalate) {
    sev = sev === 'LOW' ? 'MEDIUM'
        : sev === 'MEDIUM' ? 'HIGH'
        : 'CRITICAL';
  }
  return sev;
}

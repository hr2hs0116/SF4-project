export const STATUSES = {
  ARRIVAL: 'ARRIVAL',
  BATTERY_INSPECTION: 'BATTERY_INSPECTION',
  CELL_INSPECTION: 'CELL_INSPECTION',
  ANOMALY_DETECTED: 'ANOMALY_DETECTED',
  QA_MAINTENANCE: 'QA_MAINTENANCE',
  RE_INSPECTION_WAITING: 'RE_INSPECTION_WAITING',
  RE_INSPECTION: 'RE_INSPECTION',
  BATTERY_QC_COMPLETE: 'BATTERY_QC_COMPLETE',
  SHIPMENT_WAITING: 'SHIPMENT_WAITING',
  SHIPMENT_COMPLETE: 'SHIPMENT_COMPLETE',
};

export const STATUS_LABELS_KR = {
  ARRIVAL: '입고',
  BATTERY_INSPECTION: '배터리 검사중',
  CELL_INSPECTION: '셀 검사중',
  ANOMALY_DETECTED: '이상 발생',
  QA_MAINTENANCE: '정비중(QA)',
  RE_INSPECTION_WAITING: '재검사 대기',
  RE_INSPECTION: '재검사중',
  BATTERY_QC_COMPLETE: '배터리 품질검사 완료',
  SHIPMENT_WAITING: '출고대기',
  SHIPMENT_COMPLETE: '출고완료',
};

export const MODELS = [
  '볼트 S', '노바 X5', '노바 X9', '노바 GT60', '노바 GT70e',
  '시티버스 E', '벡터 E3', '벡터 E4', '벡터 E6', '벡터 E9', '벡터 V5', '벡터 밴 EV',
];

export const BRANDS = ['노바', '벡터'];

// 공장별 생산 모델 매핑
export const FACTORY_MODELS = {
  '청림공장': ['볼트 S', '노바 X5', '노바 GT60', '노바 GT70e'],
  '은하공장': ['노바 X9'],
  '백운공장': ['시티버스 E'],
  '단풍공장': ['벡터 E9', '벡터 E3', '벡터 E4'],
  '태양공장': ['벡터 E6', '벡터 V5'],
  '한빛공장': ['벡터 밴 EV'],
};

export const INSPECTION_STEPS = [
  { name: 'SOC_CHECK', order: 1, labelKR: 'SOC 검사', durationKey: 'inspection_soc_duration_ms' },
  { name: 'SOH_CHECK', order: 2, labelKR: 'SOH 검사', durationKey: 'inspection_soh_duration_ms' },
  { name: 'SOP_CHECK', order: 3, labelKR: 'SOP 검사', durationKey: 'inspection_sop_duration_ms' },
  { name: 'PACK_VOLTAGE_CHECK', order: 4, labelKR: '팩 전압 검사', durationKey: 'inspection_pack_voltage_duration_ms' },
  { name: 'CELL_TEMPERATURE_CHECK', order: 5, labelKR: '셀 온도 검사', durationKey: 'inspection_cell_duration_ms' },
  { name: 'CELL_VOLTAGE_CHECK', order: 6, labelKR: '셀 전압 검사', durationKey: 'inspection_cell_duration_ms' },
];

export const RANGES = {
  soc: { min: 90, max: 100, lowAbn: 80, highAbn: 85 },
  soh: { min: 95, max: 100 },
  sop: { min: 90, max: 100 },
  pack_voltage: { min: 350, max: 400 },
  cell_temperature: { min: 20, max: 35 },
  cell_voltage: { min: 3.6, max: 4.2 },
};

<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: String,
  value: Number,
  unit: { type: String, default: '' },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  normalMin: Number,
  normalMax: Number,
  status: { type: String, default: 'PENDING' },
});

function pct() {
  if (props.value == null) return 0;
  const p = ((props.value - props.min) / (props.max - props.min)) * 100;
  return Math.max(0, Math.min(100, p));
}

const cardClass = computed(() => {
  if (props.status === 'PASS') return 'border-emerald-200 bg-emerald-50/40';
  if (props.status === 'FAIL') return 'border-red-200 bg-red-50/40';
  if (props.status === 'IN_PROGRESS') return 'border-hyundai-200 bg-hyundai-50/40';
  return 'border-slate-200 bg-slate-50/40';
});

const valueColor = computed(() => {
  if (props.status === 'PASS') return 'text-emerald-700';
  if (props.status === 'FAIL') return 'text-red-600';
  if (props.status === 'IN_PROGRESS') return 'text-hyundai-500';
  return 'text-slate-300';
});

const barColor = computed(() => {
  if (props.status === 'PASS') return '#10b981';
  if (props.status === 'FAIL') return '#dc2626';
  if (props.status === 'IN_PROGRESS') return '#3b82f6';
  return '#cbd5e1';
});

const showValue = computed(() => props.status !== 'PENDING');
</script>

<template>
  <div class="p-4 rounded-xl border" :class="cardClass">
    <div class="flex items-center justify-between">
      <div class="text-xs font-semibold text-slate-600">{{ label }}</div>
      <span v-if="status === 'PASS'" class="badge-green">PASS</span>
      <span v-else-if="status === 'FAIL'" class="badge-red">FAIL</span>
      <span v-else-if="status === 'IN_PROGRESS'" class="text-[10px] px-2 py-0.5 rounded-full bg-hyundai-50 text-hyundai-500 font-semibold pulse-blue">측정 중</span>
      <span v-else class="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 font-semibold">대기</span>
    </div>
    <div class="text-2xl font-bold mt-1" :class="valueColor">
      <template v-if="showValue">{{ value?.toFixed?.(2) ?? '-' }}<span class="text-sm text-slate-500 ml-1">{{ unit }}</span></template>
      <template v-else><span class="text-slate-300">—</span></template>
    </div>
    <div class="mt-2 bg-slate-100 h-2 rounded-full overflow-hidden">
      <div v-if="showValue" class="h-full rounded-full"
           :style="{ width: pct() + '%', background: barColor }"></div>
    </div>
    <div class="mt-1 text-[10px] text-slate-400 flex justify-between">
      <span>{{ min }}{{ unit }}</span><span>정상 {{ normalMin }}~{{ normalMax }}{{ unit }}</span><span>{{ max }}{{ unit }}</span>
    </div>
  </div>
</template>

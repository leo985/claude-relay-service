<template>
  <div aria-label="快捷设置调度优先级" class="flex items-center gap-1.5">
    <span class="shrink-0 text-[11px] font-medium text-gray-500 dark:text-gray-400">
      <i class="fas fa-sort-amount-up mr-1 text-blue-500" />优先级
    </span>
    <div
      class="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm dark:border-gray-600 dark:bg-gray-800"
    >
      <button
        v-for="preset in presets"
        :key="preset.value"
        :aria-pressed="isSelected(preset.value)"
        :class="[
          'min-w-[38px] border-r border-gray-200 px-1.5 py-1 text-[11px] font-semibold transition-colors last:border-r-0 dark:border-gray-600',
          isSelected(preset.value)
            ? 'bg-blue-600 text-white dark:bg-blue-500 dark:text-gray-950'
            : 'text-gray-600 hover:bg-blue-50 hover:text-blue-700 dark:text-gray-300 dark:hover:bg-blue-900/30 dark:hover:text-blue-300',
          loading ? 'cursor-wait opacity-70' : ''
        ]"
        :disabled="loading || isSelected(preset.value)"
        :title="isSelected(preset.value) ? `当前${preset.label}` : `设为${preset.label}`"
        type="button"
        @click="$emit('select', preset.value)"
      >
        <i v-if="loading && Number(pendingValue) === preset.value" class="fas fa-spinner fa-spin" />
        <span v-else>{{ preset.value }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  value: { type: [Number, String], default: 50 },
  loading: { type: Boolean, default: false },
  pendingValue: { type: [Number, String], default: null },
  presets: {
    type: Array,
    default: () => [
      { value: 10, label: '最高优先级 (10)' },
      { value: 20, label: '高优先级 (20)' },
      { value: 25, label: '较高优先级 (25)' },
      { value: 50, label: '默认优先级 (50)' }
    ]
  }
})

defineEmits(['select'])

const isSelected = (preset) => Number(props.value) === Number(preset)
</script>

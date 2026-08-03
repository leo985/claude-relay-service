<template>
  <div aria-label="快捷设置每日配额" class="mt-2 flex items-center gap-1.5">
    <span class="shrink-0 text-[11px] font-medium text-gray-500 dark:text-gray-400">
      <i class="fas fa-bolt mr-1 text-amber-500" />配额
    </span>
    <div
      class="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm dark:border-gray-600 dark:bg-gray-800"
    >
      <button
        v-for="preset in presets"
        :key="preset"
        :aria-pressed="isSelected(preset)"
        :class="[
          'min-w-[42px] border-r border-gray-200 px-2 py-1 text-[11px] font-semibold transition-colors last:border-r-0 dark:border-gray-600',
          isSelected(preset)
            ? 'bg-cyan-600 text-white dark:bg-cyan-500 dark:text-gray-950'
            : 'text-gray-600 hover:bg-cyan-50 hover:text-cyan-700 dark:text-gray-300 dark:hover:bg-cyan-900/30 dark:hover:text-cyan-300',
          loading ? 'cursor-wait opacity-70' : ''
        ]"
        :disabled="loading || isSelected(preset)"
        :title="isSelected(preset) ? `当前每日配额 $${preset}` : `设置每日配额为 $${preset}`"
        type="button"
        @click="$emit('select', preset)"
      >
        <i v-if="loading && Number(pendingValue) === preset" class="fas fa-spinner fa-spin" />
        <span v-else>${{ preset }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  value: { type: [Number, String], default: 0 },
  loading: { type: Boolean, default: false },
  pendingValue: { type: [Number, String], default: null },
  presets: { type: Array, default: () => [50, 100, 150] }
})

defineEmits(['select'])

const isSelected = (preset) => Number(props.value) === Number(preset)
</script>

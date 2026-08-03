<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-[1050] flex items-center justify-center bg-gray-900/45 px-4 backdrop-blur-sm"
    >
      <button aria-label="关闭" class="absolute inset-0 cursor-default" @click="handleClose" />

      <section
        aria-labelledby="api-key-billing-multiplier-title"
        aria-modal="true"
        class="relative z-10 w-full max-w-md overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
        role="dialog"
      >
        <header
          class="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800"
        >
          <div class="min-w-0">
            <h3
              id="api-key-billing-multiplier-title"
              class="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              隐藏倍率
            </h3>
            <p class="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
              {{ apiKey?.name || apiKey?.id || '未知 Key' }}
            </p>
          </div>
          <button
            class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            :disabled="saving"
            title="关闭"
            @click="handleClose"
          >
            <i class="fas fa-times" />
          </button>
        </header>

        <div class="px-5 py-5">
          <div v-if="loading" class="flex h-28 items-center justify-center text-gray-500">
            <i class="fas fa-spinner fa-spin mr-2" />
            加载中...
          </div>

          <template v-else>
            <div class="mb-2">
              <label
                class="text-sm font-medium text-gray-700 dark:text-gray-300"
                for="api-key-billing-multiplier"
              >
                Key 计费倍率
              </label>
            </div>
            <div class="relative">
              <input
                id="api-key-billing-multiplier"
                v-model.number="multiplier"
                class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 pr-10 text-sm text-gray-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                inputmode="decimal"
                max="100"
                min="0.01"
                step="0.01"
                type="number"
                @keyup.enter="save"
              />
              <span
                class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-gray-400"
              >
                x
              </span>
            </div>
            <div class="mt-3 flex items-center justify-between text-xs text-gray-500">
              <span>0.01x - 100x</span>
              <button
                class="font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                type="button"
                @click="multiplier = 1"
              >
                恢复 1x
              </button>
            </div>
          </template>
        </div>

        <footer
          class="flex justify-end gap-3 border-t border-gray-100 bg-gray-50 px-5 py-3 dark:border-gray-800 dark:bg-gray-900"
        >
          <button
            class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            :disabled="saving"
            @click="handleClose"
          >
            取消
          </button>
          <button
            class="flex min-w-[88px] items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-400"
            :disabled="loading || saving"
            @click="save"
          >
            <i :class="['fas', saving ? 'fa-spinner fa-spin' : 'fa-save']" />
            {{ saving ? '保存中' : '保存' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import { showToast } from '@/utils/tools'
import { getApiKeyBillingMultiplierApi, updateApiKeyBillingMultiplierApi } from '@/utils/http_apis'

const props = defineProps({
  show: { type: Boolean, default: false },
  apiKey: { type: Object, default: null }
})

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const saving = ref(false)
const multiplier = ref(1)

const load = async () => {
  if (!props.apiKey?.id) return
  loading.value = true
  multiplier.value = 1
  try {
    const result = await getApiKeyBillingMultiplierApi(props.apiKey.id)
    if (!result?.success) {
      showToast(result?.error || result?.message || '加载隐藏倍率失败', 'error')
      return
    }
    multiplier.value = Number(result.data?.multiplier) || 1
  } finally {
    loading.value = false
  }
}

const save = async () => {
  const value = Number(multiplier.value)
  if (!Number.isFinite(value) || value < 0.01 || value > 100) {
    showToast('倍率必须在 0.01x 到 100x 之间', 'warning')
    return
  }

  saving.value = true
  try {
    const result = await updateApiKeyBillingMultiplierApi(props.apiKey.id, value)
    if (!result?.success) {
      showToast(result?.error || result?.message || '保存隐藏倍率失败', 'error')
      return
    }

    multiplier.value = Number(result.data?.multiplier) || 1
    showToast('隐藏倍率已更新', 'success')
    emit('saved', result.data)
    emit('close')
  } finally {
    saving.value = false
  }
}

const handleClose = () => {
  if (!saving.value) emit('close')
}

watch(
  () => [props.show, props.apiKey?.id],
  ([show]) => {
    if (show) load()
  }
)
</script>

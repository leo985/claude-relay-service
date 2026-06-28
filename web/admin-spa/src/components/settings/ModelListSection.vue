<template>
  <div>
    <!-- 状态卡片 -->
    <div
      class="mb-6 rounded-xl border border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 dark:border-gray-700 dark:from-blue-900/20 dark:to-indigo-900/20"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <div
            class="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400"
          >
            <i class="fas fa-list text-xl" />
          </div>
          <div>
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">
              当前模式:
              <span v-if="isCustomEnabled" class="font-bold text-blue-600 dark:text-blue-400"
                >自定义配置</span
              >
              <span v-else class="font-bold text-gray-500 dark:text-gray-400">默认列表</span>
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              模型数量: {{ isCustomEnabled ? customModels.length : defaultModels.length }}
              <span v-if="updatedAt" class="ml-2">| 上次更新: {{ formatDateTime(updatedAt) }}</span>
            </p>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            class="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="loadDefaultList"
          >
            <i class="fas fa-download" />
            加载默认
          </button>
          <button
            v-if="isCustomEnabled"
            class="flex items-center gap-2 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-700 dark:bg-gray-800 dark:hover:bg-red-900/20"
            @click="handleReset"
          >
            <i class="fas fa-undo" />
            恢复默认
          </button>
          <button
            :class="[
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition',
              saving
                ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
                : 'bg-blue-500 text-white hover:bg-blue-600 hover:shadow-md'
            ]"
            :disabled="saving"
            @click="handleSave"
          >
            <i :class="['fas', saving ? 'fa-spinner fa-spin' : 'fa-save']" />
            {{ saving ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 说明 -->
    <div
      class="mb-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-600 dark:bg-gray-700/50 dark:text-gray-400"
    >
      <i class="fas fa-info-circle mr-2 text-blue-500"></i>
      配置客户端调用
      <code class="rounded bg-gray-200 px-1 dark:bg-gray-600">/v1/models</code>
      时返回的模型列表。每行一个模型，格式为
      <code class="rounded bg-gray-200 px-1 dark:bg-gray-600">模型ID, 提供商</code>
      （逗号分隔，提供商可自定义，如 openai、glm、anthropic；不填则为 other）。保存后立即生效。
    </div>

    <!-- 批量编辑 -->
    <div
      class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300">
          <i class="fas fa-edit mr-2 text-blue-500"></i>
          模型列表（每行一个，格式：model_id, provider）
        </h3>
        <span class="text-xs text-gray-400">{{ editModels.length }} 个模型</span>
      </div>
      <textarea
        v-model="editText"
        class="h-96 w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-sm text-gray-700 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300"
        placeholder="claude-opus-4-5-20251101, anthropic&#10;gpt-5.1-codex, openai&#10;gemini-2.5-pro, google&#10;..."
        spellcheck="false"
      ></textarea>

      <!-- 快捷操作 -->
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
          @click="loadDefaultList"
        >
          <i class="fas fa-file-import mr-1"></i> 填入默认列表
        </button>
        <button
          class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
          @click="sortModels"
        >
          <i class="fas fa-sort-alpha-down mr-1"></i> 排序
        </button>
        <button
          class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
          @click="deduplicate"
        >
          <i class="fas fa-copy mr-1"></i> 去重
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getModelsConfigApi, updateModelsConfigApi, resetModelsConfigApi } from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const loading = ref(false)
const saving = ref(false)
const customModels = ref([])
const defaultModels = ref([])
const isCustomEnabled = ref(false)
const updatedAt = ref(null)
const updatedBy = ref(null)
const editText = ref('')

// 解析文本为模型数组
const parseText = (text) => {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/[,，]/).map((s) => s.trim())
      const id = parts[0]
      const provider = parts[1] || 'other'
      return { id, provider }
    })
}

// 模型数组转文本
const modelsToText = (models) => {
  return models.map((m) => `${m.id}, ${m.provider}`).join('\n')
}

// 编辑后的模型列表
const editModels = computed(() => parseText(editText.value))

const formatDateTime = (dateStr) => {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString('zh-CN')
}

// 加载数据
const loadData = async () => {
  loading.value = true
  try {
    const result = await getModelsConfigApi()
    if (result.success) {
      customModels.value = result.data.customModels || []
      defaultModels.value = result.data.defaultModels || []
      isCustomEnabled.value = result.data.isCustomEnabled
      updatedAt.value = result.data.updatedAt
      updatedBy.value = result.data.updatedBy

      // 编辑区显示当前生效的列表
      const activeModels = isCustomEnabled.value ? customModels.value : defaultModels.value
      editText.value = modelsToText(activeModels)
    } else {
      showToast(result.message || '加载模型配置失败', 'error')
    }
  } catch (error) {
    console.error('加载模型配置失败:', error)
    showToast('加载模型配置失败', 'error')
  } finally {
    loading.value = false
  }
}

// 加载默认列表到编辑区
const loadDefaultList = () => {
  editText.value = modelsToText(defaultModels.value)
  showToast('已填入默认模型列表', 'info')
}

// 排序
const sortModels = () => {
  const models = [...editModels.value].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })
  editText.value = modelsToText(models)
}

// 去重
const deduplicate = () => {
  const seen = new Set()
  const models = []
  for (const m of editModels.value) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      models.push(m)
    }
  }
  editText.value = modelsToText(models)
  showToast(`去重完成，剩余 ${models.length} 个模型`, 'info')
}

// 保存
const handleSave = async () => {
  const models = editModels.value
  if (models.length === 0) {
    showToast('模型列表不能为空', 'error')
    return
  }

  saving.value = true
  try {
    const result = await updateModelsConfigApi({ models })
    if (result.success) {
      isCustomEnabled.value = true
      customModels.value = models
      updatedAt.value = result.data?.updatedAt
      updatedBy.value = result.data?.updatedBy
      showToast(`模型列表已保存，共 ${models.length} 个模型`, 'success')
    } else {
      showToast(result.message || '保存失败', 'error')
    }
  } catch (error) {
    console.error('保存模型配置失败:', error)
    showToast('保存模型配置失败', 'error')
  } finally {
    saving.value = false
  }
}

// 恢复默认
const handleReset = async () => {
  if (!confirm('确定恢复默认模型列表吗？当前自定义配置将被清除。')) return

  try {
    const result = await resetModelsConfigApi()
    if (result.success) {
      isCustomEnabled.value = false
      customModels.value = []
      editText.value = modelsToText(defaultModels.value)
      updatedAt.value = null
      updatedBy.value = null
      showToast('已恢复默认模型列表', 'success')
    } else {
      showToast(result.message || '恢复失败', 'error')
    }
  } catch (error) {
    console.error('恢复默认模型配置失败:', error)
    showToast('恢复默认模型配置失败', 'error')
  }
}

onMounted(loadData)
</script>

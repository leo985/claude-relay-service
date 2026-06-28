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
            <i class="fas fa-coins text-xl" />
          </div>
          <div>
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">
              模型总数:
              <span class="font-bold text-blue-600 dark:text-blue-400">{{ modelCount }}</span>
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              上次更新: {{ lastUpdated }} · 来源: {{ sourceLabel }}
            </p>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            class="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-600 hover:shadow-md"
            @click="openCreateDialog"
          >
            <i class="fas fa-plus" />
            新增模型价格
          </button>
          <button
            :class="[
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition',
              refreshing
                ? 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500'
                : 'bg-blue-500 text-white hover:bg-blue-600 hover:shadow-md'
            ]"
            :disabled="refreshing"
            @click="handleRefresh"
          >
            <i :class="['fas', refreshing ? 'fa-spinner fa-spin' : 'fa-sync-alt']" />
            {{ refreshing ? '刷新中...' : '从远端刷新' }}
          </button>
        </div>
      </div>
      <p class="mt-3 text-xs text-blue-700/80 dark:text-blue-300/80">
        手动保存后价格会存入数据库并作为计费来源；从远端刷新会用镜像价格覆盖当前数据库价格。
      </p>
    </div>

    <!-- 搜索 + 平台筛选 -->
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="relative flex-1">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          v-model="searchQuery"
          class="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-700 placeholder-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          placeholder="搜索模型名称..."
          type="text"
        />
      </div>
      <div class="flex gap-1">
        <button
          v-for="tab in platformTabs"
          :key="tab.key"
          :class="[
            'rounded-lg px-3 py-2 text-xs font-medium transition',
            activePlatform === tab.key
              ? 'bg-blue-500 text-white shadow-sm'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
          ]"
          @click="activePlatform = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="py-12 text-center">
      <i class="fas fa-spinner fa-spin mb-4 text-2xl text-blue-500" />
      <p class="text-gray-500 dark:text-gray-400">加载价格数据中...</p>
    </div>

    <!-- 表格 -->
    <div v-else class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th
              class="cursor-pointer px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              @click="toggleSort('name')"
            >
              模型名称
              <i
                v-if="sortField === 'name'"
                :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
              />
            </th>
            <th
              class="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              @click="toggleSort('input')"
            >
              输入 $/MTok
              <i
                v-if="sortField === 'input'"
                :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
              />
            </th>
            <th
              class="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              @click="toggleSort('output')"
            >
              输出 $/MTok
              <i
                v-if="sortField === 'output'"
                :class="['fas ml-1', sortAsc ? 'fa-sort-up' : 'fa-sort-down']"
              />
            </th>
            <th
              class="hidden px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 md:table-cell"
            >
              缓存创建
            </th>
            <th
              class="hidden px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 md:table-cell"
            >
              缓存读取
            </th>
            <th
              class="hidden px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 lg:table-cell"
            >
              上下文窗口
            </th>
            <th
              class="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              操作
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
          <tr
            v-for="model in sortedModels"
            :key="model.name"
            class="transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
          >
            <td class="whitespace-nowrap px-3 py-2.5">
              <div class="font-medium text-gray-900 dark:text-gray-100">{{ model.name }}</div>
              <div v-if="model.provider" class="text-xs text-gray-400">{{ model.provider }}</div>
            </td>
            <td
              class="whitespace-nowrap px-3 py-2.5 text-right font-mono text-gray-700 dark:text-gray-300"
            >
              {{ formatPrice(model.inputCost) }}
            </td>
            <td
              class="whitespace-nowrap px-3 py-2.5 text-right font-mono text-gray-700 dark:text-gray-300"
            >
              {{ formatPrice(model.outputCost) }}
            </td>
            <td
              class="hidden whitespace-nowrap px-3 py-2.5 text-right font-mono text-gray-500 dark:text-gray-400 md:table-cell"
            >
              {{ formatPrice(model.cacheCreateCost) }}
            </td>
            <td
              class="hidden whitespace-nowrap px-3 py-2.5 text-right font-mono text-gray-500 dark:text-gray-400 md:table-cell"
            >
              {{ formatPrice(model.cacheReadCost) }}
            </td>
            <td
              class="hidden whitespace-nowrap px-3 py-2.5 text-right text-gray-500 dark:text-gray-400 lg:table-cell"
            >
              {{ formatContext(model.maxTokens) }}
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 text-right">
              <button
                class="mr-2 rounded-md px-2 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
                @click="openEditDialog(model)"
              >
                编辑
              </button>
              <button
                class="rounded-md px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
                @click="handleDeletePricing(model)"
              >
                删除
              </button>
            </td>
          </tr>
          <tr v-if="sortedModels.length === 0">
            <td class="px-3 py-8 text-center text-gray-500 dark:text-gray-400" colspan="7">
              <i class="fas fa-search mb-2 text-2xl text-gray-300 dark:text-gray-600" />
              <p>没有匹配的模型</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 模型数量统计 -->
    <div v-if="!loading" class="mt-3 text-right text-xs text-gray-400 dark:text-gray-500">
      显示 {{ sortedModels.length }} / {{ allModels.length }} 个模型
    </div>

    <div
      v-if="showPricingDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="closePricingDialog"
    >
      <div
        class="w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {{ editingModelName ? '编辑模型价格' : '新增模型价格' }}
            </h3>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              价格按 $/MTok 输入，保存时会转换成数据库中的 per-token 价格。
            </p>
          </div>
          <button
            class="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            @click="closePricingDialog"
          >
            <i class="fas fa-times" />
          </button>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              模型名称
            </span>
            <input
              v-model.trim="pricingForm.model"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:disabled:bg-gray-800/60"
              :disabled="!!editingModelName"
              placeholder="例如 gpt-5.4"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              Provider
            </span>
            <input
              v-model.trim="pricingForm.provider"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              placeholder="openai / anthropic / google"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              输入 $/MTok
            </span>
            <input
              v-model="pricingForm.inputCost"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="0.0001"
              type="number"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              输出 $/MTok
            </span>
            <input
              v-model="pricingForm.outputCost"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="0.0001"
              type="number"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              缓存创建 $/MTok
            </span>
            <input
              v-model="pricingForm.cacheCreateCost"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="0.0001"
              type="number"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              缓存读取 $/MTok
            </span>
            <input
              v-model="pricingForm.cacheReadCost"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="0.0001"
              type="number"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              1小时缓存创建 $/MTok
            </span>
            <input
              v-model="pricingForm.ephemeral1hCost"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="0.0001"
              type="number"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
              上下文窗口 tokens
            </span>
            <input
              v-model="pricingForm.maxTokens"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              min="0"
              step="1"
              type="number"
            />
          </label>
        </div>

        <div class="mt-6 flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            @click="closePricingDialog"
          >
            取消
          </button>
          <button
            class="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            :disabled="savingPricing"
            @click="saveModelPricing"
          >
            <i v-if="savingPricing" class="fas fa-spinner fa-spin mr-1" />
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  deleteModelPricingApi,
  getModelPricingApi,
  getModelPricingStatusApi,
  refreshModelPricingApi,
  updateModelPricingApi
} from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

// ========== 状态 ==========
const loading = ref(false)
const refreshing = ref(false)
const pricingData = ref({})
const pricingStatus = ref({})
const searchQuery = ref('')
const activePlatform = ref('all')
const sortField = ref('name')
const sortAsc = ref(true)
const showPricingDialog = ref(false)
const savingPricing = ref(false)
const editingModelName = ref('')
const pricingForm = ref({
  model: '',
  provider: '',
  inputCost: '',
  outputCost: '',
  cacheCreateCost: '',
  cacheReadCost: '',
  ephemeral1hCost: '',
  maxTokens: ''
})

const platformTabs = [
  { key: 'all', label: '全部' },
  { key: 'claude', label: 'Claude' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'other', label: '其他' }
]

// ========== 计算属性 ==========
const modelCount = computed(() => Object.keys(pricingData.value).length)

const lastUpdated = computed(() => {
  if (!pricingStatus.value.lastUpdated) return '未知'
  return new Date(pricingStatus.value.lastUpdated).toLocaleString('zh-CN')
})

const sourceLabel = computed(() => {
  const source = pricingStatus.value.source
  const sourceMap = {
    remote: '远端镜像',
    fallback: '内置兜底',
    manual: '数据库手动配置',
    database: '数据库'
  }
  return sourceMap[source] || '数据库'
})

const allModels = computed(() =>
  Object.entries(pricingData.value).map(([name, data]) => ({
    name,
    raw: data,
    provider: data.litellm_provider || detectProvider(name),
    inputCost: (data.input_cost_per_token || 0) * 1e6,
    outputCost: (data.output_cost_per_token || 0) * 1e6,
    cacheCreateCost: (data.cache_creation_input_token_cost || 0) * 1e6,
    cacheReadCost: (data.cache_read_input_token_cost || 0) * 1e6,
    ephemeral1hCost: (data.cache_creation_input_token_cost_above_1hr || 0) * 1e6,
    maxTokens: data.max_tokens || data.max_output_tokens || 0
  }))
)

const filteredModels = computed(() => {
  let models = allModels.value

  // 平台筛选
  if (activePlatform.value !== 'all') {
    const platformFilters = {
      claude: (n) => n.includes('claude'),
      gemini: (n) => n.includes('gemini'),
      openai: (n) =>
        n.includes('gpt') ||
        n.includes('o1') ||
        n.includes('o3') ||
        n.includes('o4') ||
        n.includes('codex'),
      other: (n) =>
        !n.includes('claude') &&
        !n.includes('gemini') &&
        !n.includes('gpt') &&
        !n.includes('o1') &&
        !n.includes('o3') &&
        !n.includes('o4') &&
        !n.includes('codex')
    }
    const filter = platformFilters[activePlatform.value]
    if (filter) models = models.filter((m) => filter(m.name.toLowerCase()))
  }

  // 搜索筛选
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    models = models.filter((m) => m.name.toLowerCase().includes(q))
  }

  return models
})

const sortedModels = computed(() => {
  const models = [...filteredModels.value]
  const fieldMap = {
    name: (m) => m.name,
    input: (m) => m.inputCost,
    output: (m) => m.outputCost
  }
  const getter = fieldMap[sortField.value]
  if (!getter) return models

  models.sort((a, b) => {
    const va = getter(a)
    const vb = getter(b)
    if (typeof va === 'string') return sortAsc.value ? va.localeCompare(vb) : vb.localeCompare(va)
    return sortAsc.value ? va - vb : vb - va
  })
  return models
})

// ========== 方法 ==========
const detectProvider = (name) => {
  const n = name.toLowerCase()
  if (n.includes('claude')) return 'Anthropic'
  if (n.includes('gemini')) return 'Google'
  if (
    n.includes('gpt') ||
    n.includes('o1') ||
    n.includes('o3') ||
    n.includes('o4') ||
    n.includes('codex')
  )
    return 'OpenAI'
  if (n.includes('deepseek')) return 'DeepSeek'
  if (n.includes('llama') || n.includes('meta')) return 'Meta'
  if (n.includes('mistral')) return 'Mistral'
  return ''
}

const formatPrice = (price) => {
  if (!price || price === 0) return '-'
  if (price < 0.01) return `$${price.toFixed(4)}`
  if (price < 1) return `$${price.toFixed(3)}`
  return `$${price.toFixed(2)}`
}

const formatContext = (tokens) => {
  if (!tokens) return '-'
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`
  return String(tokens)
}

const toggleSort = (field) => {
  if (sortField.value === field) {
    sortAsc.value = !sortAsc.value
  } else {
    sortField.value = field
    sortAsc.value = true
  }
}

const emptyForm = () => ({
  model: '',
  provider: '',
  inputCost: '',
  outputCost: '',
  cacheCreateCost: '',
  cacheReadCost: '',
  ephemeral1hCost: '',
  maxTokens: ''
})

const toDisplayPrice = (value) => {
  if (value === undefined || value === null || value === '') return ''
  return Number(value) * 1e6
}

const toOptionalNumber = (value) => {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : NaN
}

const setPerTokenField = (target, field, value) => {
  const num = toOptionalNumber(value)
  if (num === null) {
    delete target[field]
    return true
  }
  if (Number.isNaN(num)) return false
  target[field] = num / 1e6
  return true
}

const setTokenField = (target, field, value) => {
  const num = toOptionalNumber(value)
  if (num === null) {
    delete target[field]
    return true
  }
  if (Number.isNaN(num)) return false
  target[field] = Math.floor(num)
  return true
}

const buildPricingPayload = () => {
  const model = pricingForm.value.model?.trim()
  if (!model) {
    showToast('请填写模型名称', 'warning')
    return null
  }

  const pricing = { ...(pricingData.value[model] || {}) }
  const valid =
    setPerTokenField(pricing, 'input_cost_per_token', pricingForm.value.inputCost) &&
    setPerTokenField(pricing, 'output_cost_per_token', pricingForm.value.outputCost) &&
    setPerTokenField(
      pricing,
      'cache_creation_input_token_cost',
      pricingForm.value.cacheCreateCost
    ) &&
    setPerTokenField(pricing, 'cache_read_input_token_cost', pricingForm.value.cacheReadCost) &&
    setPerTokenField(
      pricing,
      'cache_creation_input_token_cost_above_1hr',
      pricingForm.value.ephemeral1hCost
    ) &&
    setTokenField(pricing, 'max_tokens', pricingForm.value.maxTokens)

  if (!valid) {
    showToast('价格和 token 数必须是非负数字', 'warning')
    return null
  }

  if (pricingForm.value.provider?.trim()) {
    pricing.litellm_provider = pricingForm.value.provider.trim()
  } else {
    delete pricing.litellm_provider
  }

  return { model, pricing }
}

const openCreateDialog = () => {
  editingModelName.value = ''
  pricingForm.value = emptyForm()
  showPricingDialog.value = true
}

const openEditDialog = (model) => {
  const raw = model.raw || {}
  editingModelName.value = model.name
  pricingForm.value = {
    model: model.name,
    provider: raw.litellm_provider || model.provider || '',
    inputCost: toDisplayPrice(raw.input_cost_per_token),
    outputCost: toDisplayPrice(raw.output_cost_per_token),
    cacheCreateCost: toDisplayPrice(raw.cache_creation_input_token_cost),
    cacheReadCost: toDisplayPrice(raw.cache_read_input_token_cost),
    ephemeral1hCost: toDisplayPrice(raw.cache_creation_input_token_cost_above_1hr),
    maxTokens: raw.max_tokens || raw.max_output_tokens || ''
  }
  showPricingDialog.value = true
}

const closePricingDialog = () => {
  if (savingPricing.value) return
  showPricingDialog.value = false
}

const saveModelPricing = async () => {
  const payload = buildPricingPayload()
  if (!payload) return

  savingPricing.value = true
  try {
    const result = await updateModelPricingApi(payload)
    if (result.success) {
      showToast('模型价格已保存', 'success')
      showPricingDialog.value = false
      await loadData()
    } else {
      showToast(result.message || '保存模型价格失败', 'error')
    }
  } catch (error) {
    showToast(error?.message || '保存模型价格失败', 'error')
  } finally {
    savingPricing.value = false
  }
}

const handleDeletePricing = async (model) => {
  if (!window.confirm(`确定删除模型价格「${model.name}」吗？`)) return

  const result = await deleteModelPricingApi({ model: model.name })
  if (result.success) {
    showToast(result.deleted ? '模型价格已删除' : '模型价格不存在', 'success')
    await loadData()
  } else {
    showToast(result.message || '删除模型价格失败', 'error')
  }
}

const loadData = async () => {
  loading.value = true
  const [pricingResult, statusResult] = await Promise.all([
    getModelPricingApi(),
    getModelPricingStatusApi()
  ])
  if (pricingResult.success) {
    pricingData.value = pricingResult.data
  } else {
    showToast(pricingResult.message || '加载模型价格失败', 'error')
  }
  if (statusResult.success) {
    pricingStatus.value = statusResult.data
  } else {
    showToast(statusResult.message || '获取价格状态失败', 'error')
  }
  loading.value = false
}

const handleRefresh = async () => {
  refreshing.value = true
  const result = await refreshModelPricingApi()
  if (result.success) {
    showToast('价格数据已刷新', 'success')
    await loadData()
  } else {
    showToast(result.message || '刷新失败', 'error')
  }
  refreshing.value = false
}

onMounted(loadData)
</script>

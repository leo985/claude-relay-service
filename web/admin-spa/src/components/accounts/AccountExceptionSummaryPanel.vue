<template>
  <section
    class="mb-6 overflow-hidden rounded-2xl border border-gray-100 bg-white/80 shadow-sm dark:border-gray-700 dark:bg-gray-900/70"
  >
    <div
      class="flex flex-col gap-3 border-b border-gray-100 bg-gray-50/70 px-4 py-4 dark:border-gray-800 dark:bg-gray-800/50 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <h4 class="flex items-center text-sm font-semibold text-gray-800 dark:text-gray-100">
          <i class="fas fa-shield-halved mr-2 text-rose-500" /> 异常状态与统计
        </h4>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          近 {{ windowDays }} 天聚合，仅统计新版本写入的异常事件
        </p>
      </div>
      <span
        class="inline-flex w-fit items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300"
      >
        <i class="fas fa-database mr-1.5" /> {{ summary?.accountType || 'unknown' }}
      </span>
    </div>

    <div class="space-y-4 p-4">
      <div :class="['rounded-2xl border p-4', currentTheme.panel]">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex gap-3">
            <div
              :class="[
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
                currentTheme.iconBg
              ]"
            >
              <i :class="['fas', currentIcon, currentTheme.iconText]" />
            </div>
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <p :class="['font-semibold', currentTheme.title]">{{ currentStatus.label }}</p>
                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', currentTheme.badge]">
                  {{ severityLabel }}
                </span>
              </div>
              <div class="mt-1 space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <p v-for="reason in currentReasons" :key="reason">{{ reason }}</p>
              </div>
            </div>
          </div>
          <div
            v-if="currentStatus.recoverAt"
            class="text-left text-xs text-gray-500 dark:text-gray-400 sm:text-right"
          >
            <span class="block">预计恢复</span>
            <span class="font-medium text-gray-700 dark:text-gray-200">{{
              formatDateTime(currentStatus.recoverAt)
            }}</span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="metric in metricCards"
          :key="metric.key"
          class="rounded-xl border border-gray-100 bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-800/60"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400">{{
              metric.label
            }}</span>
            <i :class="['fas', metric.icon, metric.iconClass]" />
          </div>
          <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {{ metric.value }}
          </p>
          <p class="mt-1 truncate text-xs text-gray-400 dark:text-gray-500">
            {{ metric.subtitle }}
          </p>
        </div>
      </div>

      <div v-if="hasStats" class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div class="rounded-xl border border-gray-100 p-4 dark:border-gray-700 xl:col-span-2">
          <div class="mb-3 flex items-center justify-between">
            <h5 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
              <i class="fas fa-chart-pie mr-2 text-amber-500" />异常分类分布
            </h5>
            <span class="text-xs text-gray-400 dark:text-gray-500"
              >共 {{ formatNumber(totals.total) }} 次</span
            >
          </div>
          <div class="space-y-3">
            <div v-for="category in byCategory" :key="category.key">
              <div class="mb-1 flex items-center justify-between gap-3 text-sm">
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    :class="[
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      categoryDotClass(category.severity)
                    ]"
                  />
                  <span class="truncate font-medium text-gray-700 dark:text-gray-200">{{
                    category.label
                  }}</span>
                  <span class="text-xs text-gray-400 dark:text-gray-500">{{ category.key }}</span>
                </div>
                <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {{ formatNumber(category.count) }} · {{ category.percent }}%
                </span>
              </div>
              <div class="h-2 rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  :class="['h-2 rounded-full', categoryBarClass(category.severity)]"
                  :style="{ width: `${Math.min(100, category.percent)}%` }"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
          <h5 class="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <i class="fas fa-hashtag mr-2 text-sky-500" />状态码 Top
          </h5>
          <div v-if="byStatusCode.length" class="space-y-2">
            <div
              v-for="item in byStatusCode.slice(0, 6)"
              :key="item.status"
              class="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-800/70"
            >
              <span class="font-medium text-gray-700 dark:text-gray-200"
                >HTTP {{ item.status }}</span
              >
              <span class="text-gray-500 dark:text-gray-400"
                >{{ formatNumber(item.count) }} 次</span
              >
            </div>
          </div>
          <div
            v-else
            class="rounded-lg bg-gray-50 px-3 py-5 text-center text-xs text-gray-400 dark:bg-gray-800/70 dark:text-gray-500"
          >
            暂无状态码聚合
          </div>
        </div>
      </div>

      <div v-if="hasStats" class="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h5 class="text-sm font-semibold text-gray-700 dark:text-gray-200">
            <i class="fas fa-chart-simple mr-2 text-indigo-500" />每日异常趋势
          </h5>
          <span class="text-xs text-gray-400 dark:text-gray-500"
            >最近 {{ dailyBars.length }} 天</span
          >
        </div>
        <div class="flex h-28 items-end gap-1.5 overflow-x-auto pb-1">
          <div
            v-for="day in dailyBars"
            :key="day.date"
            class="flex min-w-[22px] flex-1 flex-col items-center gap-1"
          >
            <div class="flex h-20 w-full items-end rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                class="w-full rounded-full bg-gradient-to-t from-rose-500 to-amber-400 transition-all"
                :style="{ height: `${dailyBarHeight(day.total)}%` }"
                :title="`${day.date}: ${day.total} 次异常`"
              />
            </div>
            <span class="text-[10px] text-gray-400 dark:text-gray-500">{{
              day.label.slice(3)
            }}</span>
          </div>
        </div>
      </div>

      <div v-if="hasStats" class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div
          v-for="section in contextSections"
          :key="section.key"
          class="rounded-xl border border-gray-100 p-4 dark:border-gray-700"
        >
          <h5 class="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <i :class="['fas', section.icon, 'mr-2', section.iconClass]" />{{ section.label }}
          </h5>
          <div v-if="section.items.length" class="space-y-2">
            <div
              v-for="item in section.items"
              :key="item.name"
              class="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-800/70"
            >
              <span class="min-w-0 truncate text-gray-700 dark:text-gray-200" :title="item.name">{{
                item.name
              }}</span>
              <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">{{
                formatNumber(item.count)
              }}</span>
            </div>
          </div>
          <div
            v-else
            class="rounded-lg bg-gray-50 px-3 py-5 text-center text-xs text-gray-400 dark:bg-gray-800/70 dark:text-gray-500"
          >
            暂无上下文数据
          </div>
        </div>
      </div>

      <div
        v-if="!hasStats"
        class="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 p-6 text-center dark:border-gray-700 dark:bg-gray-800/50"
      >
        <i class="fas fa-inbox mb-2 text-2xl text-gray-300 dark:text-gray-600" />
        <p class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ emptyTitle }}</p>
        <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
          {{ emptyNote }}
          <span v-if="summary?.statsAvailableFrom">
            · 起始 {{ formatDateTime(summary.statsAvailableFrom) }}</span
          >
        </p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { formatNumber } from '@/utils/tools'

const props = defineProps({
  exceptionSummary: { type: Object, default: null }
})

const unavailableCurrentStatus = {
  isBlocked: false,
  primaryCategory: null,
  label: '状态未加载',
  severity: 'unknown',
  reasons: ['异常统计暂不可用'],
  recoverAt: null
}

const defaultCurrentStatus = {
  isBlocked: false,
  primaryCategory: null,
  label: '当前正常',
  severity: 'success',
  reasons: ['当前账号未检测到异常状态'],
  recoverAt: null
}

const severityThemes = {
  success: {
    panel: 'border-emerald-100 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-900/20',
    iconBg: 'bg-emerald-100 dark:bg-emerald-500/20',
    iconText: 'text-emerald-600 dark:text-emerald-300',
    title: 'text-emerald-800 dark:text-emerald-200',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200'
  },
  warning: {
    panel: 'border-amber-100 bg-amber-50/80 dark:border-amber-500/20 dark:bg-amber-900/20',
    iconBg: 'bg-amber-100 dark:bg-amber-500/20',
    iconText: 'text-amber-600 dark:text-amber-300',
    title: 'text-amber-800 dark:text-amber-200',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200'
  },
  error: {
    panel: 'border-rose-100 bg-rose-50/80 dark:border-rose-500/20 dark:bg-rose-900/20',
    iconBg: 'bg-rose-100 dark:bg-rose-500/20',
    iconText: 'text-rose-600 dark:text-rose-300',
    title: 'text-rose-800 dark:text-rose-200',
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200'
  },
  critical: {
    panel: 'border-red-100 bg-red-50/80 dark:border-red-500/20 dark:bg-red-900/20',
    iconBg: 'bg-red-100 dark:bg-red-500/20',
    iconText: 'text-red-600 dark:text-red-300',
    title: 'text-red-800 dark:text-red-200',
    badge: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200'
  },
  neutral: {
    panel: 'border-gray-200 bg-gray-50/80 dark:border-gray-700 dark:bg-gray-800/60',
    iconBg: 'bg-gray-100 dark:bg-gray-700',
    iconText: 'text-gray-600 dark:text-gray-300',
    title: 'text-gray-800 dark:text-gray-200',
    badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }
}

const severityText = {
  success: '正常',
  warning: '关注',
  error: '异常',
  critical: '阻塞',
  neutral: '停调',
  unknown: '未加载'
}

const summary = computed(() => props.exceptionSummary || {})
const hasSummary = computed(() => !!props.exceptionSummary)
const windowDays = computed(() => summary.value.windowDays || 30)
const currentStatus = computed(() => {
  if (!hasSummary.value) return unavailableCurrentStatus
  return summary.value.current || defaultCurrentStatus
})
const currentTheme = computed(
  () => severityThemes[currentStatus.value.severity] || severityThemes.neutral
)
const severityLabel = computed(() => severityText[currentStatus.value.severity] || '未知')
const currentReasons = computed(() => {
  const reasons = currentStatus.value.reasons || []
  return reasons.length ? reasons : defaultCurrentStatus.reasons
})
const currentIcon = computed(() => {
  if (!currentStatus.value.isBlocked) return 'fa-circle-check'
  if (currentStatus.value.severity === 'critical') return 'fa-ban'
  if (currentStatus.value.severity === 'warning') return 'fa-triangle-exclamation'
  return 'fa-circle-exclamation'
})
const totals = computed(() => summary.value.totals || { total: 0, affectedDays: 0, latestAt: null })
const byCategory = computed(() => summary.value.byCategory || [])
const byStatusCode = computed(() => summary.value.byStatusCode || [])
const hasStats = computed(() => Number(totals.value.total || 0) > 0)
const topCategory = computed(() => byCategory.value[0] || null)
const dailyBars = computed(() => (summary.value.daily || []).slice(-14))
const maxDailyTotal = computed(() => Math.max(1, ...dailyBars.value.map((item) => item.total || 0)))
const topContexts = computed(() => summary.value.topContexts || {})
const emptyTitle = computed(() =>
  hasSummary.value ? `近 ${windowDays.value} 天暂无异常聚合记录` : '异常统计暂不可用'
)
const emptyNote = computed(() =>
  hasSummary.value
    ? summary.value.note || '异常聚合从新版本上线后开始累计'
    : '本次未返回异常聚合数据，不影响使用统计展示'
)

const metricCards = computed(() => [
  {
    key: 'total',
    label: '异常总数',
    value: formatNumber(totals.value.total || 0),
    subtitle: `近 ${windowDays.value} 天累计`,
    icon: 'fa-bolt',
    iconClass: 'text-rose-500'
  },
  {
    key: 'affectedDays',
    label: '影响天数',
    value: `${totals.value.affectedDays || 0} 天`,
    subtitle: '出现异常的日期数',
    icon: 'fa-calendar-days',
    iconClass: 'text-amber-500'
  },
  {
    key: 'topCategory',
    label: '最高频异常',
    value: topCategory.value?.label || '暂无',
    subtitle: topCategory.value ? `${formatNumber(topCategory.value.count)} 次` : '暂无异常分类',
    icon: 'fa-layer-group',
    iconClass: 'text-indigo-500'
  },
  {
    key: 'latestAt',
    label: '最近异常',
    value: totals.value.latestAt ? formatDateTime(totals.value.latestAt) : '暂无',
    subtitle: '最后一次聚合时间',
    icon: 'fa-clock',
    iconClass: 'text-sky-500'
  }
])

const contextSections = computed(() => [
  {
    key: 'models',
    label: 'Top 模型',
    icon: 'fa-cube',
    iconClass: 'text-blue-500',
    items: topContexts.value.models || []
  },
  {
    key: 'paths',
    label: 'Top 路径',
    icon: 'fa-route',
    iconClass: 'text-emerald-500',
    items: topContexts.value.paths || []
  },
  {
    key: 'apiKeys',
    label: 'Top API Key',
    icon: 'fa-key',
    iconClass: 'text-amber-500',
    items: topContexts.value.apiKeys || []
  }
])

const formatDateTime = (value) => {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const dailyBarHeight = (total) => (total > 0 ? Math.max(8, (total / maxDailyTotal.value) * 100) : 0)

const categoryDotClass = (severity) => {
  if (severity === 'critical') return 'bg-red-500'
  if (severity === 'error') return 'bg-rose-500'
  if (severity === 'warning') return 'bg-amber-500'
  if (severity === 'success') return 'bg-emerald-500'
  return 'bg-gray-400'
}

const categoryBarClass = (severity) => {
  if (severity === 'critical') return 'bg-red-500'
  if (severity === 'error') return 'bg-rose-500'
  if (severity === 'warning') return 'bg-amber-500'
  if (severity === 'success') return 'bg-emerald-500'
  return 'bg-gray-400'
}
</script>

# 账号详情异常状态分类统计设计

> 状态：设计稿  
> 日期：2026-06-22  
> 目标：在账号管理页的账号详情中，按异常状态分类展示当前状态与历史异常统计，帮助快速判断账号不可用原因和异常分布。

## 1. 背景

当前账号管理页已经具备：

- 账号列表状态展示：正常、异常、限流、临时暂停、不可调度等。
- 账号统计汇总弹窗：按平台粗略统计正常、不可调度、限流时间段、其他。
- 账号详情弹窗：展示费用、请求、Token 和 30 天趋势。
- 错误历史弹窗：展示最近错误列表。

但账号详情弹窗中没有按异常状态分类统计，导致查看单个账号时无法快速回答：

- 当前账号为什么不可路由？
- 近 30 天主要异常是什么？
- 异常集中在哪些状态码、模型、接口或 API Key？
- 限流、认证失败、上游 5xx、临时暂停分别发生多少次？

## 2. 现状数据流

### 前端

- `web/admin-spa/src/views/AccountsView.vue`
  - 账号列表与筛选排序。
  - 点击“详情”打开 `AccountUsageDetailModal`。
  - 调用 `getAccountUsageHistoryApi(account.id, account.platform, 30)`。
- `web/admin-spa/src/components/accounts/AccountUsageDetailModal.vue`
  - 展示 `history / summary / overview / generatedAt`。
  - 当前未接收异常统计数据。
- `web/admin-spa/src/components/accounts/AccountErrorHistoryModal.vue`
  - 展示最近 3 天错误历史列表。
  - 当前不做聚合统计。

### 后端

- `src/routes/admin/usageStats.js`
  - `GET /admin/accounts/:accountId/usage-history`
  - 返回账号 30 天使用趋势和汇总。
- `src/routes/admin/errorHistory.js`
  - `GET /admin/accounts/:accountType/:accountId/error-history`
  - 返回 Redis List 中的错误历史。
- `src/utils/upstreamErrorHelper.js`
  - `recordErrorHistory()` 写入 `error_history:{accountType}:{accountId}`。
  - 错误历史当前 TTL 为 3 天，不适合作为 30 天统计的唯一来源。

## 3. 设计目标

1. 在账号详情弹窗展示“当前异常状态”和“历史异常分类统计”。
2. 复用现有账号状态字段和错误历史记录，不破坏现有列表与错误历史功能。
3. 建立后端每日聚合，支持近 7/30/60 天异常统计。
4. 统一异常分类口径，避免列表、详情、接口各自定义不同状态。
5. 前端在没有历史聚合数据时优雅降级。

## 4. 非目标

- 不改变现有账号调度策略。
- 不改变现有 `error_history` 明细列表结构。
- 不在第一阶段改造账号列表筛选逻辑。
- 不依赖扫描所有请求明细或所有 API Key usage record 来统计异常。

## 5. 异常分类口径

统一定义异常分类，后端用于聚合，前端用于展示文案与颜色。

| key | 显示名 | 判断来源 | 严重度 |
| --- | --- | --- | --- |
| `auth_error` | 认证失败 | HTTP 401/403、`errorType=auth_error`、`status=unauthorized` | critical |
| `rate_limit` | 限流 | HTTP 429、`errorType=rate_limit`、`rateLimitStatus` | warning |
| `service_unavailable` | 服务不可用 | HTTP 503、`errorType=service_unavailable` | warning |
| `overload` | 上游过载 | HTTP 529、`errorType=overload`、`overloadStatus` | warning |
| `timeout` | 超时 | HTTP 504、`errorType=timeout` | warning |
| `server_error` | 服务端错误 | 其他 5xx、`errorType=server_error` | error |
| `quota_exceeded` | 配额不足 | `status=quota_exceeded`、`quotaAutoStopped`、`quotaStoppedAt` | critical |
| `temp_unavailable` | 临时暂停 | `tempUnavailable`、`temp_unavailable:*` | warning |
| `manual_paused` | 手动停调 | `schedulable=false` 且无自动异常原因 | neutral |
| `expired` | 已过期 | `expiresAt` 已过期且该平台参与过期路由判断 | critical |
| `account_blocked` | 账号封锁 | `status=blocked/account_blocked` | critical |
| `unknown_error` | 其他异常 | 无法归入以上分类 | error |

### 优先级

当前状态可能同时命中多个异常，例如限流且不可调度。展示主状态时按优先级选一个：

1. `account_blocked`
2. `auth_error`
3. `quota_exceeded`
4. `expired`
5. `rate_limit`
6. `overload`
7. `temp_unavailable`
8. `service_unavailable`
9. `timeout`
10. `server_error`
11. `manual_paused`
12. `unknown_error`

详情中仍保留全部原因列表。

## 6. 后端设计

### 6.1 新增异常分类模块

建议新增：

```txt
src/utils/accountExceptionClassifier.js
```

职责：

- `classifyErrorEvent({ statusCode, errorType, context })`
- `classifyCurrentAccountStatus(account)`
- `getExceptionCategoryMeta(key)`
- `normalizeAccountType(platform)`

兼容约定：

- 新分类器只服务于“异常统计展示”和接口聚合，不替换 `upstreamErrorHelper.js` 里现有的 `classifyError(statusCode)`。
- `markTempUnavailable()` 仍使用旧 `classifyError(statusCode)` 决定是否暂停及暂停 TTL，避免改变调度策略。
- `token_refresh_failed` 这类没有 HTTP status 的错误，在新分类器中归为 `auth_error`；无法识别的 `errorType` 归为 `unknown_error`。

该模块被 `upstreamErrorHelper.js`、`usageStats.js` 和测试复用。

### 6.2 每日聚合 Redis Key

在 `recordErrorHistory()` 写明细时同步写聚合，但不修改现有函数签名：

```js
recordErrorHistory(accountId, accountType, statusCode, errorType, context = null)
```

原因：当前约 12 处调用点已经依赖该签名，且多数调用点没有稳定传入 model/path/apiKey。第一阶段保持兼容，只从 `context` 中做 best-effort 提取上下文字段。

Key：

```txt
account_error_stats:daily:{accountType}:{accountId}:{yyyy-mm-dd}
```

Hash 字段：

```txt
total
type:{categoryKey}
status:{statusCode}
errorType:{errorType}
model:{model}
path:{path}
apiKey:{apiKeyName}
latestAt
```

字段来源：

| 聚合字段 | 来源 | 缺失策略 |
| --- | --- | --- |
| `type:{categoryKey}` | `accountExceptionClassifier.classifyErrorEvent({ statusCode, errorType, context })` | 缺失时写入 `type:unknown_error` |
| `status:{statusCode}` | `statusCode` | `0/null/undefined` 不写 `status:*` |
| `errorType:{errorType}` | `errorType` | 缺失时不写 |
| `model:{model}` | `context.model / context.requestedModel / context.upstreamModel` | 缺失时不写 |
| `path:{path}` | `context.path / context.endpoint / context.url` | 缺失时不写 |
| `apiKey:{apiKeyName}` | `context.apiKeyName / context.keyName / context.apiKeyId` | 缺失时不写 |

说明：

- `topContexts` 是可选统计，不能作为验收的硬指标；早期调用点没有传 `context` 时，Top 模型/路径/API Key 可能为空。
- 后续可逐步给高价值调用点补充 `context`，例如 relay 层可传入 `model/path/apiKeyName`，但第一阶段不批量改所有调用点。
- 聚合写入必须复用 `recordErrorHistory()` 现有 Redis pipeline，把 `hincrby/hset/expire` 加入同一个 pipeline，不新增独立 Redis 往返。

示例：

```txt
account_error_stats:daily:openai:acc_123:2026-06-22
  total = 12
  type:rate_limit = 6
  type:auth_error = 2
  status:429 = 6
  status:401 = 2
  model:gpt-5 = 4
  path:/v1/messages = 8
  latestAt = 2026-06-22T09:12:00.000Z
```

TTL：

- 建议 60 天或 90 天。
- 第一阶段可固定为 60 天。

### 6.3 扩展账号详情接口

扩展现有接口：

```http
GET /admin/accounts/:accountId/usage-history?platform=claude&days=30&includeExceptions=true
```

兼容策略：

- `includeExceptions` 默认为 `true` 或第一阶段显式开启均可。
- 即使异常统计失败，也不影响 usage history 主数据返回。
- 查询聚合前必须通过固定映射把 `platform` 转成 `error_history` 使用的 `accountType`，不能直接使用平台字符串。

`platform` -> `accountType` 映射：

| usage-history `platform` | error history `accountType` | 说明 |
| --- | --- | --- |
| `claude` | `claude-official` | Claude 官方账号历史 key 使用 `claude-official` |
| `claude-console` | `claude-console` | Claude Console |
| `openai` | `openai` | OpenAI token 账号 |
| `openai-responses` | `openai-responses` | OpenAI-compatible / Responses 账号 |
| `gemini` | `gemini` | 当前可能没有完整错误历史，保留映射以便后续接入 |
| `gemini-api` | `gemini-api` | Gemini API Key 账号 |
| `droid` | `droid` | Droid 账号 |
| `bedrock` | `bedrock` | Bedrock 账号 |

新增响应字段：

```json
{
  "exceptionSummary": {
    "windowDays": 30,
    "current": {
      "isBlocked": true,
      "primaryCategory": "rate_limit",
      "label": "限流中",
      "severity": "warning",
      "reasons": ["触发限流（约 2小时 后恢复）"],
      "recoverAt": "2026-06-22T12:30:00.000Z"
    },
    "totals": {
      "total": 18,
      "affectedDays": 5,
      "latestAt": "2026-06-22T09:12:00.000Z"
    },
    "byCategory": [
      {
        "key": "rate_limit",
        "label": "限流",
        "count": 10,
        "percent": 55.56,
        "latestAt": "2026-06-22T09:12:00.000Z"
      }
    ],
    "byStatusCode": [{ "status": 429, "count": 10 }],
    "daily": [
      {
        "date": "2026-06-22",
        "label": "06/22",
        "total": 4,
        "rate_limit": 3,
        "auth_error": 1
      }
    ],
    "topContexts": {
      "models": [{ "name": "gpt-5", "count": 6 }],
      "paths": [{ "name": "/v1/messages", "count": 8 }],
      "apiKeys": [{ "name": "default-key", "count": 4 }]
    },
    "recent": []
  }
}
```

### 6.4 历史数据兼容

因为旧版本没有每日聚合：

- 聚合上线后从上线时间开始累计。
- 第一阶段不读取 `error_history` 反推或补充近 3 天聚合，避免 list 明细与 daily hash 聚合口径不一致。
- 当没有聚合数据时返回空统计，并带说明字段：

```json
{
  "exceptionSummary": {
    "statsAvailableFrom": "2026-06-22T00:00:00.000Z",
    "note": "异常聚合从新版本上线后开始累计"
  }
}
```

如需历史回填，应单独设计离线脚本，明确读取窗口、分类口径和幂等标记，不放入账号详情接口的在线请求链路。

### 6.5 清理与一致性约定

现有“清除错误历史”会调用：

```js
clearErrorHistory(accountType, accountId)
```

新增 daily hash 后必须保持行为一致：

- `clearErrorHistory()` 同时删除 `error_history:{accountType}:{accountId}` 和 `account_error_stats:daily:{accountType}:{accountId}:*`。
- 不建议全库 `SCAN` 大范围匹配；第一阶段可按 TTL 天数生成日期 key 后批量 `DEL`，例如近 60 天 daily key + 当前 list key。
- 删除动作使用 pipeline 批量执行，避免管理端一次清理造成多次 Redis 往返。
- 清理后账号详情的 `exceptionSummary` 应返回空统计和 `statsAvailableFrom/note`，不能出现“明细已清空但统计仍有数”的状态。

## 7. 前端设计

### 7.1 数据接入

在 `AccountsView.vue` 增加状态：

```js
const accountExceptionSummary = ref(null)
```

打开详情时重置并接收：

```js
accountExceptionSummary.value = null
const response = await httpApis.getAccountUsageHistoryApi(account.id, account.platform, 30, {
  includeExceptions: true
})
accountExceptionSummary.value = response.data?.exceptionSummary || null
```

传给详情弹窗：

```vue
<AccountUsageDetailModal
  :exception-summary="accountExceptionSummary"
/>
```

### 7.2 API 封装调整

将 `getAccountUsageHistoryApi` 改为支持参数对象：

```js
export const getAccountUsageHistoryApi = (id, platform, days = 30, options = {}) =>
  request({
    url: `/admin/accounts/${id}/usage-history`,
    method: 'GET',
    params: {
      platform,
      days,
      includeExceptions: options.includeExceptions !== false
    }
  })
```

### 7.3 新增展示组件

建议新增：

```txt
web/admin-spa/src/components/accounts/AccountExceptionSummaryPanel.vue
```

职责：

- 展示当前状态卡片。
- 展示异常分类分布。
- 展示每日异常趋势。
- 展示 Top 模型、Top 路径、Top API Key。
- 提供入口打开现有错误历史弹窗或请求时间线。

建议放置位置：

- 在 `AccountUsageDetailModal.vue` 的“关键指标”之后、“今日与峰值”之前。

### 7.4 UI 布局

账号详情新增区域：

1. 当前状态横幅
   - 正常：绿色。
   - 不可路由：红色。
   - 限流/临时暂停/上游过载：橙色。
   - 手动停调：灰色。
2. 统计卡片
   - 近 N 天异常总数。
   - 影响天数。
   - 最高频异常。
   - 最近异常时间。
3. 分类分布
   - 横向条形图或列表。
   - 点击分类可过滤最近异常列表。
4. 趋势图
   - 简化阶段可先用列表/迷你柱图。
   - 后续可接 Chart.js 堆叠柱状图。
5. 空状态
   - “近 30 天暂无异常记录”。
   - “异常统计从新版本上线后开始累计”。

## 8. 与现有账号统计弹窗的关系

现有“账户统计汇总”仍保留，用于全局平台级概览。

本设计新增的是单账号详情统计：

- 全局统计：多少账号处于异常状态。
- 账号详情统计：这个账号异常发生了什么、发生多少次、最近何时发生。

后续可以把同一套分类器复用到全局统计弹窗，让“其他”拆分为认证失败、服务端错误、配额不足、过期等更细分类。

## 9. 实施计划

### Phase 1：后端聚合与接口

- 新增 `accountExceptionClassifier`。
- 修改 `recordErrorHistory()` 同步写每日聚合，但保持签名不变，聚合上下文从 `context` best-effort 提取。
- 修改 `clearErrorHistory()` 同步清理每日聚合 key。
- 扩展 `/admin/accounts/:accountId/usage-history` 返回 `exceptionSummary`。
- 固定 `platform -> accountType` 映射，确保 `platform=claude` 查询 `claude-official` 历史。
- 增加单元测试覆盖分类器和接口聚合。

### Phase 2：详情弹窗展示

- 修改 `getAccountUsageHistoryApi` 参数。
- 在 `AccountsView.vue` 接入 `exceptionSummary`。
- 新增 `AccountExceptionSummaryPanel.vue`。
- 在详情弹窗中展示当前状态、分类统计和趋势。

### Phase 3：全局统计复用

- 将账号统计弹窗中的“其他”进一步拆分。
- 状态筛选支持按具体异常类型过滤。
- 增加“只看当前不可路由账号”的快捷筛选。

## 10. 测试计划

### 后端

- 分类器：
  - 401/403 -> `auth_error`
  - 429 -> `rate_limit`
  - 503 -> `service_unavailable`
  - 529 -> `overload`
  - 504 -> `timeout`
  - 500/502 -> `server_error`
- 聚合写入：
  - `recordErrorHistory()` 写入 list 的同时写 daily hash。
  - `recordErrorHistory()` 函数签名保持不变。
  - `model/path/apiKeyName` 缺失时不报错。
  - 缺少上下文字段时 `topContexts` 允许为空。
  - TTL 正确设置。
  - daily hash 写入复用同一个 Redis pipeline。
- 清理：
  - `clearErrorHistory()` 同时清除 list 和对应 daily hash。
  - 清除后详情接口返回空异常统计。
- 接口：
  - 无异常返回空统计。
  - 有多天异常返回 `byCategory / byStatusCode / daily / topContexts`。
  - `platform=claude` 能查到 `accountType=claude-official` 的异常统计。
  - 异常统计失败不影响 usage history。
  - 旧数据不做在线回填，仅返回 `statsAvailableFrom/note`。

### 前端

- 详情弹窗无异常时显示空态。
- 详情弹窗有异常时显示分类卡片。
- 当前状态命中多个异常时，主状态按优先级展示，原因列表完整展示。
- 深色模式样式可读。
- 移动端弹窗不横向溢出。

## 11. 风险与注意事项

- 错误历史 TTL 只有 3 天，不能直接作为 30 天统计来源。
- 不同平台 accountType 命名不完全一致，需要统一映射：
  - `claude` -> `claude-official`
  - `claude-console` -> `claude-console`
  - `openai` -> `openai`
  - `openai-responses` -> `openai-responses`
  - `gemini` -> `gemini`
  - `gemini-api` -> `gemini-api`
  - `droid` -> `droid`
  - `bedrock` -> `bedrock`
- `usage-history` 当前允许的平台中不包含 Azure OpenAI；本设计第一阶段不覆盖 Azure 账号详情异常统计。
- 当前状态是实时字段，历史异常是聚合字段，两者不能混为一个指标。
- 第一阶段不要改变调度逻辑，避免引入路由行为回归。
- 聚合 key 的字段数量需要控制，`model/path/apiKey` Top 统计可以只保留前端展示需要的摘要，避免高基数字段无限增长。
- 旧 `classifyError(statusCode)` 与新 `accountExceptionClassifier` 的口径不同，必须明确调用边界；新分类器不能影响临时暂停 TTL。

## 12. 验收标准

- 账号详情中能看到“异常状态统计”区域。
- 正常账号显示当前正常、近 N 天无异常。
- 有异常账号能看到按分类聚合的数量和最近异常时间。
- 错误历史仍可正常打开和清除；清除后异常统计同步归零。
- `platform=claude` 的官方账号异常统计不为空时能正常展示。
- 现有账号列表、账号统计汇总、使用趋势不受影响。

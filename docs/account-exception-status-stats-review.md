# 账号详情异常状态分类统计 - 评审问题清单

> 评审对象：`docs/account-exception-status-stats-design.md`
> 评审日期：2026-06-22
> 评审结论：主体设计为"加法式"，不直接破坏现有功能；但存在若干与现状对不上的隐患，按原文实施会出现"看似没坏、实际数据对不上"的隐性回归。

---

## 一、不破坏现有功能的部分（已核实）

1. **`includeExceptions` 查询参数** — `usageStats.js:245` 当前只从 `req.query` 解构 `platform` 和 `days`，新增参数不冲突，纯加法。
2. **`getAccountUsageHistoryApi` 签名扩展** — 现 `(id, platform, days=30)` → 改为 `(id, platform, days=30, options={})`，向后兼容。唯一调用点 `AccountsView.vue:2737`，同步更新即可。
3. **`AccountUsageDetailModal` 新增 prop / 新增区段** — 该组件是纯展示组件（只接收 props，不自取数据，见 props 定义 `AccountUsageDetailModal.vue:343-351`）。新增 `:exception-summary` 并在"关键指标"（line 69）与"今日与峰值"（line 99）之间插入新区段，不影响既有 6 个区段。
4. **`AccountExceptionSummaryPanel.vue` 是全新文件** — 不存在，无冲突。
5. **新增 `accountExceptionClassifier` 模块** — 现仓无此模块，无冲突。

---

## 二、与现状对不上、会导致隐性回归的隐患（需在实施前修正）

### 隐患 1：`recordErrorHistory` 签名拿不到 model/path/apiKey ⚠️ 关键

设计 §6.2 要求每日聚合 hash 含 `model:{model}`、`path:{path}`、`apiKey:{apiKeyName}`，并说"在 `recordErrorHistory()` 写明细时同步写聚合"。

但现状 `recordErrorHistory` 签名是（`upstreamErrorHelper.js:214-220`）：

```js
recordErrorHistory(accountId, accountType, statusCode, errorType, context = null)
```

- **根本没有 model/path/apiKeyName 入参**，这些字段偶尔才出现在自由形态的 `context` 对象里，且大多数调用点（约 12 处，如 `ccrAccountService.js:372`、`openaiAccountService.js:969`）只传 `errorBody` 甚至不传 context。

**后果**：若按原文实施，要么改签名（动 12 个调用点，有回归风险），要么从 context 里挖（数据大量缺失，Top 模型/路径/API Key 统计基本是空的）。

**建议**：设计需明确这两个字段从哪里来，否则 §6.3 的 `topContexts` 在 claude/ccr 等平台会长期为空。

### 隐患 2：`accountType` 命名映射不完整，claude 账号统计可能对不上 ⚠️

`error_history` key 用的是 `accountType`（取值 `claude-official`、`claude-console`、`ccr`、`openai`、`openai-responses`、`gemini-api`），而 usage-history 路由只有 `:accountId`，靠 `platform` 查询参数区分。现状 `usageStats.js:264-270` 的 `accountTypeMap` 里 **`claude` → `null`**（因为 claudeAccountService 实际用 `claude-official`），`claude-console` 才有值。

设计 §11 提到要做映射，但列的 `claude / claude-official` 像是两个并列值，没说清"platform=claude 要映射到 accountType=claude-official"。

**后果**：若映射写错，**claude 官方账号的异常统计会查不到 key，返回空**，表现为"账号明明有限流记录、详情里却显示近 30 天无异常"——隐性回归。

**建议**：在设计里把 platform→accountType 的完整映射表写死，并覆盖测试。

### 隐患 3："清除错误历史"不会清除新增的每日聚合数据 ⚠️

`errorHistory.js:27-42` 的 `DELETE` 路由只调 `clearErrorHistory()`，后者只清 `error_history:{accountType}:{accountId}` 这一个 list。新增的 `account_error_stats:daily:...` hash **不在清除范围内**。

**后果**：用户点"清除历史"后，明细列表空了，但异常分类统计卡片里还显示着历史计数——**与既有功能行为不一致，用户体验上属于回归**。设计 §12 验收标准写了"错误历史仍可正常打开和清除"，但没要求同步清除聚合数据。

**建议**：需在 `clearErrorHistory` 里一并删除对应 daily hash（或加一个 pattern scan），否则验收标准实际不满足。

### 隐患 4：与既有 `classifyError` 的关系未说明

`upstreamErrorHelper.js:145-165` 已有一个内联 `classifyError(statusCode)`，被 `markTempUnavailable` 用来决定暂停 TTL，且**部分调用方（如 `token_refresh_failed`）直接绕过它传 errorType**。设计引入新的 `accountExceptionClassifier.classifyErrorEvent`（口径更宽，含 errorType/context/status 字段）。

两者**口径不同**（旧的只看 status code，且 4xx 非 401/403/429 返回 null；新的有 12 类）。这本身不破坏现有功能，但设计应明确：

- 新分类器仅供"统计展示"，**不替换** `markTempUnavailable` 用的旧 `classifyError`（否则会改变调度暂停行为，触发 §4 "不改变调度策略"的非目标红线）。
- 旧 `classifyError` 的 `token_refresh_failed` 这类无 status 的错误，在新分类器里归到 `unknown_error` 还是 `auth_error`，要明确，否则统计会漏掉 token 刷新失败这类常见异常。

### 隐患 5：聚合写入需复用同一 pipeline，避免性能回归

现状 `recordErrorHistory` 用单个 Redis pipeline（`lpush`+`ltrim`+`expire`），且所有调用方都是 fire-and-forget `.catch(()=>{})`。设计说"同步写聚合"。

**后果**：**必须把 daily hash 的 `hincrby`/`expire` 加进同一 pipeline**，不能改成独立 await 调用，否则每个错误多一次 Redis 往返，在高频限流场景会放大延迟，间接影响转发主链路。

**建议**：设计补一句"复用现有 pipeline，不新增独立 Redis 调用"。

---

## 三、小问题

- **§11 提到 `azure_openai / azure-openai`**，但 `usageStats.js` 的 `allowedPlatforms` 8 项里**没有 azure**，且本仓未见 azure accountService。要么是历史残留，要么 azure 走另一套路由——设计里列出来会让读者误以为 azure 也接 usage-history。建议删除或注明。
- **§6.4 "最近 3 天读 error_history 做补充统计"**：两个数据源 schema 不同（list 是 `{time,status,errorType,context}`，daily hash 是聚合），合并时按 category 归并需要二次分类，实现复杂度被低估。第一阶段建议**不做合并**，直接返回空统计 + `statsAvailableFrom` 说明，避免引入统计口径不一致的 bug。

---

## 四、总结

| 项 | 对现有功能的影响 |
|---|---|
| 新增查询参数 / 前端签名 / 新组件 / 新模块 | ✅ 纯加法，无破坏 |
| model/path/apiKey 聚合来源（隐患 1） | ⚠️ 签名拿不到，Top 统计会空 |
| platform→accountType 映射（隐患 2） | ⚠️ claude 映射缺失，统计查不到 |
| 清除历史不清聚合数据（隐患 3） | ⚠️ 与"清除"行为不一致，验收不达标 |
| 与旧 classifyError 共存（隐患 4） | ⚠️ 需明确不替换，否则改调度行为 |
| pipeline 复用（隐患 5） | ⚠️ 不复用会拖慢转发主链路 |

**建议**：设计本身方向正确、风险可控，但实施前需补齐上述 5 处（尤其隐患 1/2/3），否则会出现"功能没报错、数据对不上"的隐性回归——这比直接报错更难排查。可在设计文档里追加一节"§6.5 与现有 `recordErrorHistory`/`clearErrorHistory`/`classifyError` 的兼容约定"把这几条写死。

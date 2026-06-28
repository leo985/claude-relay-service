# 未提交实现评审报告

> 评审日期：2026-06-27
> 评审范围：当前工作区未提交改动（28 文件，+1752 / -1302）
> 改动主题：① 定价系统从文件迁移到 Redis ② 模型列表页面化配置 ③ OpenAI-Responses 网络错误重试 ④ 前端样式/主题扁平化重构

整体质量较高，主要风险集中在错误处理边界与并发写入。

---

## 🔴 HIGH

### 1. 中流网络错误时 `res.status().json()` 会抛异常

`src/services/relay/openaiResponsesRelayService.js` catch 块末尾：

```js
if (networkErrorResponse) {
  await this._markRetryableNetworkFailures(nextPendingNetworkFailures)
  return res.status(networkErrorResponse.status).json(networkErrorResponse.body)  // ← headers 已发送时抛错
}
```

`canRetryNetworkError` 已用 `!res.headersSent` 阻止重试，但**回落到 504/502 JSON 分支没有同样保护**。当上游在 SSE 流已开始后断连（ECONNRESET），`isRetryableNetworkError` 为 true、`networkErrorResponse` 被设置，但 `res.headersSent` 为 true → `res.status()` 抛 "Cannot set headers after they are sent"，请求挂起/未捕获。

> 注：旧代码回落到 `res.status(500).json()` 也有同样隐患，但旧逻辑网络错误不 return 会继续走到 500，问题等价。新代码恶化点在于网络错误现在明确走 JSON 分支。

**修复**：加守卫并优雅结束流：

```js
if (networkErrorResponse) {
  await this._markRetryableNetworkFailures(nextPendingNetworkFailures)
  if (res.headersSent || res.writableEnded) {
    return res.destroy()
  }
  return res.status(networkErrorResponse.status).json(networkErrorResponse.body)
}
```

---

## 🟡 MEDIUM

### 2. `saveModelPricing` 缺 try/catch，异常时 spinner 卡死

`web/admin-spa/src/components/settings/ModelPricingSection.vue`：

```js
const saveModelPricing = async () => {
  ...
  savingPricing.value = true
  const result = await updateModelPricingApi(payload)  // reject 则下面不执行
  if (result.success) { ... }
  savingPricing.value = false   // ← 网络异常时不会执行
}
```

`loadData` 有 try/catch，此处却没有。`updateModelPricingApi` reject 时 `savingPricing` 永不复位，保存按钮永久禁用。`handleDeletePricing` 同样无 try/catch（无 stuck flag，但错误冒泡到全局处理器）。建议统一 try/finally 复位 `savingPricing`。

### 3. 定价读写为读改写全量覆盖，多实例/并发可丢数据

`pricingService.upsertModelPricing` / `deleteModelPricing`：

```js
const data = { ...(await this.ensurePricingDataLoaded()) }  // 用内存缓存
data[model] = { ...existing, ...normalized }
await this.savePricingDataToDatabase(data, ...)              // 整张 map 覆盖写回
```

问题：

- `this.pricingData` 是单实例内存缓存，**多进程部署**时 A 进程 upsert 后，B 进程仍持旧 `pricingData`，B 再 upsert 会覆盖 A 的修改。
- 无 Redis 事务（MULTI/EXEC 保护读改写），两个管理员并发编辑存在 last-write-wins 丢数据。

管理员操作频率低，但定价数据影响计费，建议至少用 WATCH/MULTI 或基于 `HMSET` 的单模型字段存储。

### 4. 单次手动编辑会全局冻结自动价格更新

`needsUpdate` 与 `syncWithRemoteHash` 在 `meta.source === 'manual'` 时直接跳过。`upsertModelPricing`/`deleteModelPricing` 都把 source 置为 `'manual'`。这意味着**编辑一个模型后，所有模型的远端自动同步永久停止**，直到有人手动点"从远端刷新"或跑 `update:pricing` 脚本（这两个会重置 source 为 remote）。

这是合理的"保护手动编辑不被覆盖"设计，但作用域是全局而非单模型，对运维是个意外陷阱。建议在 UI（已有 `sourceLabel` 提示，好）和 README 明确说明该行为；或考虑 per-model override 表而非全局冻结。

### 5. `/models/config` GET 硬编码 Redis key

`src/routes/admin/system.js:540` 直接 `redis.client.get('system:models_config')`，与 `modelService.CONFIG_KEY` 重复。key 改动会静默断裂。建议在 modelService 暴露 `getCustomModelsMeta()` 复用。

---

## 🟢 LOW

### 6. pricingService 死代码

`this.pricingFile`、`this.localHashFile`、`dataDir`/mkdir、`setupFileWatcher`（已变 no-op 但 `initialize` 仍调用）、`handleFileChange`/`reloadPricingData` 防抖（无文件监听后永不触发）、`persistLocalHash` 不再写哈希文件。建议清理。

### 7. modelService 死代码

`getModelsByProvider`/`isModelSupported`/`getModelProvider` 改 async 后无任何外部调用方（grep 确认只有内部定义）。YAGNI，可删。

### 8. DELETE 带 body

`deleteModelPricingApi` 用 DELETE + body，axios 可用但部分代理会剥离 DELETE body。考虑改 query param。

### 9. `handleDeletePricing` UX

`result.deleted === false`（模型不存在）时仍弹 success toast"模型价格不存在"。建议区分提示类型。

### 10. 既有问题（非本次回归）：暗色文本变量未覆盖

`theme.js` 不覆盖 `--text-primary/--text-secondary/--modal-bg`，暗色模式下这些变量保持浅色值。`global.css:151,245,359`、`components.css:147`、`main.css:24`、`ApiKeyInput.vue:247` 用 `var(--text-primary)` → 暗色实色背景上可能是黑字。扁平化让背景变实色后更易暴露，建议在 theme.js 暗色分支补 `--text-primary:#f3f4f6` 等。

### 11. 测试脆弱

`tests/openaiImageRoutes.test.js` 中 `registeredGetRoutes = mockRouter.get.mock.calls.map(([path,_m,handler])=>…)` 假定所有 `router.get` 恰好 3 参数，未来加 2 参数路由会错位。

### 12. 测试覆盖缺口

`pricingServiceDatabase.test.js` 未覆盖 `deleteModelPricing`、`normalizeModelPricing` 校验失败、`needsUpdate` manual 跳过、fallback seed 路径。

---

## ✅ 做得好的地方

- **sync→async 迁移安全**：`modelService.getAllModels()` 仅 `openaiRoutes.js`/`api.js` 两处调用，均已 await；`apiStats.js` 用的是独立的同步 `config/models` 模块，不受影响。
- **OpenAI 重试逻辑严谨**：`maxNetworkRetries:1` 有界、`excludeAccountIds` 在调度器三处路径一致实现、重试前清粘性会话、仅在重试耗尽后才标记账号不可用（避免误伤）、重试前 `!res.headersSent` 守卫。
- **定价 DB 迁移连贯**：data+meta 双 key、哈希校验、manual 冻结、fallback seed 闭环。
- **ModelPricingSection 编辑保留字段**：`buildPricingPayload` 用 `{...pricingData[model]}` 保留未编辑的扩展字段，$/MTok↔per-token 换算正确，保存/删除后 `await loadData()` 重载。
- **新增组件暗色模式覆盖完整**（`dark:` 前缀贯穿）。

---

## 修复优先级建议

1. **#1（流式错误守卫）** — 确定性 bug，影响线上请求稳定性
2. **#2（spinner try/finally）** — 确定性 UI bug，用户可感知
3. **#3（并发写入）** — 多实例/并发场景数据丢失，按部署形态评估
4. 其余 MEDIUM/LOW 按需处理

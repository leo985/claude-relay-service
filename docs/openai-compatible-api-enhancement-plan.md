# 改造方案：支持通用 OpenAI 兼容 API 配置（修订版）

> 日期：2026-06-07  
> 目标：在现有 OpenAI-Responses 账户类型基础上，扩展为可调度、可校验、可安全配置的通用 OpenAI 兼容 API 中转能力，支持 Responses API、Chat Completions API，以及高级原样转发场景。

---

## 一、修订结论

原计划的方向正确，但需要先补齐 **协议模式、路由时机、调度语义、安全边界**。否则只新增字段会出现以下问题：

- `providerEndpoint=completions` 当前后端不接受；实际只允许 `responses` / `auto`。
- `/openai/v1/chat/completions` 当前会先在 unified 路由里转成 Responses 请求，再进入 OpenAI-Responses relay；`auto` 不能真正保持原始 Chat Completions body/path。
- 未知模型当前会被智能路由默认送往 Claude，无法依赖账户级 `boundModel` 后置覆盖来选择 OpenAI 兼容账户。
- `boundModel` 如果只在 relay 阶段覆盖，调度器、分组、sticky session 都已经选完账号，无法保证选中正确提供商。
- `customHeaders` 可能承载密钥，不能按普通 JSON 明文返回或允许覆盖关键协议头。

因此本修订版将改造拆为四个核心能力：

1. 明确定义 provider 协议模式。
2. 在路由/调度阶段完成 OpenAI 兼容账户选择。
3. 在 relay 阶段按协议构造上游请求并安全注入 headers。
4. 前端和验证计划按真实行为调整。

---

## 二、现状分析

### 2.1 已有能力

现有 **OpenAI-Responses 账户**（`src/services/account/openaiResponsesAccountService.js`）已具备：

| 字段 | 说明 | 状态 |
|------|------|------|
| `baseApi` | API 基础地址 | 已有 |
| `apiKey` | API 密钥（AES-256-CBC 加密存储） | 已有 |
| `providerEndpoint` | 当前实际支持 `responses` / `auto` | 已有但语义需修正 |
| `userAgent` | 自定义 User-Agent | 已有 |
| `proxy` | 代理配置 | 已有 |
| `priority` | 调度优先级 (1-100) | 已有 |
| `isActive` / `schedulable` | 激活/可调度状态 | 已有 |
| `dailyQuota` / `rateLimitDuration` | 额度/限流管理 | 已有 |

### 2.2 需要补齐的能力

| 能力 | 字段/功能 | 目标 |
|------|-----------|------|
| 协议模式 | `providerEndpoint` 扩展 | 明确 Responses / Chat Completions / 原样转发三种行为 |
| 账户级模型绑定 | `boundModel` | 上游 model override，同时参与调度匹配 |
| 模型别名（可选） | `modelAliases` | 支持客户端 model 与上游 model 不一致的映射 |
| 能力标记 | `supportsTools` / `supportsImages` / `supportsReasoning` | 调度前过滤或 relay 前校验/降级 |
| 输出上限 | `maxOutputTokens` | 对 `max_output_tokens` / `max_tokens` 做安全钳制 |
| 输入上限 | `maxInputTokens` | Phase 1 只作为配置展示；精确限制需 tokenizer 支持 |
| 自定义协议头 | `customHeaders` | 支持 `X-API-Key` 等额外认证头，敏感值加密/脱敏 |

### 2.3 涉及文件

```
后端：
  src/routes/unified.js                                — Chat Completions 智能路由入口
  src/routes/openaiRoutes.js                           — Responses / OpenAI 账户选择入口
  src/services/scheduler/unifiedOpenAIScheduler.js      — 统一调度器
  src/services/account/openaiResponsesAccountService.js — 账户 CRUD + 字段解析/加密
  src/services/relay/openaiResponsesRelayService.js     — 上游请求构造和转发
  src/routes/admin/openaiResponsesAccounts.js           — 管理 API 错误码/校验
  config/models.js                                      — 模型预设（可选）

前端：
  web/admin-spa/src/components/accounts/AccountForm.vue — 账户创建/编辑表单
```

---

## 三、协议模式定义（Phase 0，必须先做）

### 3.1 providerEndpoint 枚举

将 `providerEndpoint` 统一定义为：

| 值 | 名称 | 行为 | 适用场景 |
|----|------|------|----------|
| `responses` | Responses API | 上游使用 `/v1/responses` 或 `/responses`，请求体为 Responses 格式 | OpenAI Responses / Codex 兼容 provider |
| `chat_completions` | Chat Completions API | 上游使用 `/v1/chat/completions` 或 `/chat/completions`，请求体为 Chat Completions 格式 | DeepSeek、Qwen、GLM 等常见 OpenAI 兼容 API |
| `passthrough` | 原样转发 | 尽量保留客户端原始 path/body，仅替换认证、代理和安全 headers | 高级自定义 provider |
| `auto` | 旧版别名 | 保留向后兼容，内部按 `passthrough` 处理 | 历史配置 |

> 不再使用 `completions` 作为枚举值。前端已有的 `Chat Completions` 选项应改为 `chat_completions`。

### 3.2 请求路径/请求体规则

| 客户端入口 | providerEndpoint | 上游 path | 上游 body |
|------------|------------------|-----------|-----------|
| `/openai/v1/chat/completions` | `chat_completions` | `/v1/chat/completions` | 原始 Chat Completions body |
| `/openai/v1/chat/completions` | `responses` | `/v1/responses` | Chat Completions 转 Responses body |
| `/openai/v1/chat/completions` | `passthrough` / `auto` | 原始 path | 原始 body |
| `/openai/v1/responses` | `responses` | `/v1/responses` | 原始 Responses body |
| `/openai/v1/responses` | `chat_completions` | `/v1/chat/completions` | Responses 转 Chat Completions body |
| `/openai/v1/responses` | `passthrough` / `auto` | `/v1/messages` | Responses 转 Anthropic Messages body |

### 3.3 路由时机要求

必须在 `unified.js` 将 Chat Completions body 转成 Responses body 之前，先保存原始请求：

```js
req._openaiCompatibleOriginal = {
  path: req.path,
  originalUrl: req.originalUrl,
  body: structuredClone(req.body),
  endpointKind: 'chat_completions'
}
```

然后根据以下顺序决定是否进入 OpenAI 兼容流：

1. API Key 显式绑定 `responses:<accountId>`：直接进入 OpenAI 兼容流。
2. API Key 绑定的 group 内存在 OpenAI-Responses 账户：进入 OpenAI 兼容流，由 group 调度。
3. 请求 model 与任一可调度 OpenAI-Responses 账户的 `boundModel` / `modelAliases` 匹配：进入 OpenAI 兼容流。
4. `/openai/*` 命名空间下未知模型：优先尝试 OpenAI 兼容流；没有可用账户再按现有 fallback 处理。
5. `/api/*` 命名空间保留现有默认行为，避免破坏旧客户端默认 Claude 路由。

---

## 四、后端改造方案

### 4.1 Account Service 字段扩展

**文件：** `src/services/account/openaiResponsesAccountService.js`

新增字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `boundModel` | string | `''` | 上游实际发送的 model；空表示不覆盖 |
| `modelAliases` | JSON array | `[]` | 可选：客户端可请求的别名/映射名 |
| `supportsTools` | boolean-string | `'true'` | 是否支持工具调用 |
| `supportsImages` | boolean-string | `'false'` | 是否支持图片输入 |
| `supportsReasoning` | boolean-string | `'false'` | 是否支持 Responses reasoning 参数 |
| `maxInputTokens` | number-string | `'0'` | 输入上限；Phase 1 仅展示/记录 |
| `maxOutputTokens` | number-string | `'0'` | 输出上限；relay 钳制 |
| `customHeaders` | encrypted JSON string | `''` | 自定义请求头，整体加密存储 |

#### 4.1.1 createAccount

- `providerEndpoint` 校验改为 `['responses', 'chat_completions', 'passthrough', 'auto']`。
- `boundModel` 创建时 `trim()`。
- `modelAliases` 统一保存为 JSON 字符串。
- 布尔值统一通过 helper 转为 `'true'` / `'false'`，不要直接对任意值 `.toString()`。
- `maxInputTokens` / `maxOutputTokens` 统一保存非负整数。
- `customHeaders` 先校验，再加密保存。

建议新增 helper：

```js
_normalizeBoolean(value, defaultValue = false)
_normalizeNonNegativeInt(value)
_normalizeStringList(value)
_normalizeCustomHeaders(value, previous = null)
_encryptCustomHeaders(headers)
_decryptCustomHeaders(encrypted)
_maskCustomHeaders(headers)
```

#### 4.1.2 updateAccount

更新规则：

| 请求字段 | 行为 |
|----------|------|
| 未传 `customHeaders` | 保持原值 |
| `customHeaders: {}` | 清空所有自定义头 |
| `customHeaders: { "X-Token": "***" }` | 保留该 key 原值 |
| `customHeaders: { "X-Token": "new" }` | 更新该 key |

校验规则：

- header name 必须是合法 HTTP header token。
- 默认禁止：`authorization`、`host`、`content-length`、`connection`、`cookie`、`set-cookie`、`proxy-authorization`。
- 自定义头只允许 string/number/boolean 值，保存时转 string。
- 不允许在日志里打印 value。

#### 4.1.3 getAccount / getAllAccounts

- `getAccount(accountId, options = {})` 支持：
  - `{ includeSecretHeaders: true }`：仅 relay 内部使用，返回解密后的真实 `customHeaders`。
  - 默认返回脱敏后的 `customHeaders`，例如 `{ "X-Token": "***" }`。
- `getAllAccounts` 永远返回脱敏 header，不返回真实值。
- 新增字段做默认值补齐，确保历史账户行为不变：

```js
accountData.boundModel = accountData.boundModel || ''
accountData.modelAliases = parseJsonArray(accountData.modelAliases)
accountData.supportsTools = accountData.supportsTools !== 'false'
accountData.supportsImages = accountData.supportsImages === 'true'
accountData.supportsReasoning = accountData.supportsReasoning === 'true'
accountData.maxInputTokens = parseInt(accountData.maxInputTokens) || 0
accountData.maxOutputTokens = parseInt(accountData.maxOutputTokens) || 0
```

> 注意：不要顺手改动既有字段 `isActive` / `schedulable` 的返回类型，否则会影响现有路由里的字符串判断。

### 4.2 统一路由改造

**文件：** `src/routes/unified.js`、`src/routes/openaiRoutes.js`

#### 4.2.1 保留原始请求

在 `/v1/chat/completions` 入口最早处保存原始 body/path，之后再做现有转换。

#### 4.2.2 OpenAI 兼容路由判定

新增一个轻量判定函数，避免未知模型直接落到 Claude：

```js
async function shouldRouteToOpenAICompatible(req, requestedModel) {
  // 1. API Key 直接绑定 responses account
  // 2. API Key 绑定 group 且 group 内有 OpenAI-Responses account
  // 3. requestedModel 匹配 boundModel/modelAliases
  // 4. /openai namespace unknown model fallback
}
```

判定为 true 后，进入 OpenAI 账户调度，不再按 Claude/Gemini 路由。

#### 4.2.3 选择账户时传递请求特征

当前 scheduler 只接收 `requestedModel`，需要扩展为：

```js
const requestFeatures = {
  endpointKind: 'chat_completions' | 'responses',
  hasTools: boolean,
  hasImages: boolean,
  hasReasoning: boolean
}

selectAccountForApiKey(apiKeyData, sessionHash, requestedModel, requestFeatures)
```

这样可以优先选择支持对应能力的账户，而不是选完后再粗暴删除字段。

### 4.3 Scheduler 模型与能力匹配

**文件：** `src/services/scheduler/unifiedOpenAIScheduler.js`

#### 4.3.1 模型匹配语义

共享池和 group 账户使用同一套 rank：

| rank | 条件 | 说明 |
|------|------|------|
| 3 | `requestedModel === boundModel` | 精确匹配，最高优先级 |
| 2 | `requestedModel in modelAliases` | 别名匹配 |
| 1 | `boundModel` 为空 | 透传兜底账户 |
| 0 | 不匹配 | 不可选 |

排序规则：

1. 过滤掉 rank=0。
2. 按 rank 降序。
3. 同 rank 内沿用现有 priority / lastUsedAt 排序。

这样 DeepSeek 示例中：

- 请求 `deepseek-chat` 时优先选 A，而不是未绑定 C。
- 请求未知模型时才选未绑定 C。

#### 4.3.2 专属账户语义

API Key 直接绑定 OpenAI-Responses 账户时：

- 不因为 requestedModel 与 `boundModel` 不一致而拒绝。
- 如果 `boundModel` 非空，relay 阶段覆盖上游 model。
- 如果需要严格校验，可后续增加 `enforceModelMatch`，默认关闭。

#### 4.3.3 Sticky session 语义

当前 sticky mapping 只保存 `{ accountId, accountType }`，需要扩展或校验：

```js
{ accountId, accountType, modelKey, endpointKind }
```

复用 mapping 前必须检查：

- 账户仍可用。
- 账户仍匹配当前 requestedModel。
- 账户支持当前 endpointKind / tools / images / reasoning。

不匹配时删除 mapping 并重新调度。

#### 4.3.4 能力匹配

调度阶段先过滤明显不支持的账户：

| 请求特征 | 账户字段 | 默认行为 |
|----------|----------|----------|
| hasTools | `supportsTools` | 不支持则不可选 |
| hasImages | `supportsImages` | 不支持则不可选 |
| hasReasoning | `supportsReasoning` | 不支持则不可选 |
| endpointKind=chat_completions | `providerEndpoint` | `chat_completions` / `passthrough` 可选 |
| endpointKind=responses | `providerEndpoint` | `responses` / `passthrough` 可选 |

如果没有账户完全支持，再根据 `capabilityPolicy` 决定返回 400 或降级删除字段。建议 Phase 1 默认 `reject`，避免破坏工具调用上下文。

#### 4.3.5 普通 OpenAI 共享账号隔离

本改造不得改变原有 `platform=openai` 共享账号的配置结构和调度语义。新增的 OpenAI 兼容字段只作用于 `accountType === 'openai-responses'` 的账户。

普通 OpenAI 账号继续沿用现有逻辑：

- 不新增 `boundModel`、`modelAliases`、`providerEndpoint`、`customHeaders` 等字段。
- 不迁移 Redis 中的 OpenAI OAuth 账号数据。
- 不改变 accessToken / refreshToken / token refresh 流程。
- 不改变现有 `supportedModels`、priority、lastUsedAt 排序逻辑。
- 不参与 OpenAI-Responses 专用的协议模式和能力标记过滤。

实现时需要在 scheduler 中显式分支，避免把新逻辑写成全局过滤：

```js
if (accountType === 'openai-responses') {
  // 仅 OpenAI-Responses / OpenAI 兼容 API 账户使用：
  // boundModel、modelAliases、providerEndpoint、supportsTools 等新逻辑
}

if (accountType === 'openai') {
  // 保持原有 OpenAI OAuth 共享账号逻辑：
  // supportedModels、priority、lastUsedAt、token refresh
}
```

唯一允许的间接变化是：当开启新路由且请求明确匹配某个 OpenAI-Responses 账户时，该请求可能被分配给 OpenAI-Responses 账户，而不是普通 OpenAI 共享池。这应仅发生在 `/openai/*` 新兼容路由命中时，不能影响 `/api/*` 的历史默认路由。

### 4.4 Relay 层请求构造

**文件：** `src/services/relay/openaiResponsesRelayService.js`

新增 `resolveUpstreamRequest(req, fullAccount)`，统一返回：

```js
{
  targetPath,
  body,
  endpointKind,
  requestedModel,
  upstreamModel
}
```

#### 4.4.1 路径和 body

- `responses`：使用 Responses body；Chat Completions 入口使用转换后的 `req.body`。
- `chat_completions`：优先使用 `req._openaiCompatibleOriginal.body` 和原始 chat path。
- `passthrough` / `auto`：优先使用原始 path/body。
- `baseApi` 已含 `/v1` 时继续避免 `/v1/v1` 重复。

#### 4.4.2 模型覆盖

在构造上游 body 后立刻覆盖：

```js
if (fullAccount.boundModel?.trim()) {
  upstreamBody.model = fullAccount.boundModel.trim()
}
```

同时在 request detail 中记录：

```js
req._openaiCompatible = {
  requestedModel,
  upstreamModel,
  modelOverridden: upstreamModel !== requestedModel,
  providerEndpoint
}
```

#### 4.4.3 能力校验/降级

根据协议分别处理：

| 能力 | Responses body | Chat Completions body |
|------|----------------|-----------------------|
| tools | `tools`、`tool_choice`、`parallel_tool_calls` | `tools`、`tool_choice` |
| images | `input[].content[].input_image` 等递归过滤/校验 | `messages[].content[].image_url` 递归过滤/校验 |
| reasoning | `reasoning`、`include: reasoning.*` | `reasoning_effort` 等扩展字段 |
| output limit | `max_output_tokens` | `max_tokens`，以及兼容 `max_output_tokens` |

默认策略建议：

- 对 tools/reasoning：不支持时返回 400，避免静默改变 agent 行为。
- 对 images：可配置为 reject 或 strip；默认 reject。
- 对 max output：安全钳制。
- `maxInputTokens` Phase 1 不做精确拦截，只在 UI/日志中作为 provider 信息；后续引入 tokenizer 后再做硬限制。

#### 4.4.4 Header 注入

构造 headers 的顺序：

1. `filterForOpenAI(req.headers)` 过滤客户端 headers。
2. 设置必要 headers：`Authorization`、`Content-Type`、`User-Agent`。
3. 合并自定义 headers，但禁止覆盖保留 headers。
4. 日志只打印 header key，不打印 value。

```js
const reservedHeaders = new Set(['authorization', 'host', 'content-length', 'connection'])
for (const [key, value] of Object.entries(extraHeaders)) {
  if (reservedHeaders.has(key.toLowerCase())) {
    logger.warn('Skipping reserved custom header', { key })
    continue
  }
  headers[key] = value
}
```

> 如果未来需要非 Bearer 认证，单独设计 `authHeaderName` / `authHeaderTemplate`，不要通过任意 customHeaders 覆盖 `Authorization`。

### 4.5 Admin API

**文件：** `src/routes/admin/openaiResponsesAccounts.js`

需要改动，不再写“无需额外改动”。

- POST/PUT 对新增字段做 schema 校验。
- 校验失败返回 400，不要被 catch 成 500。
- POST 保持当前 200 响应即可；除非统一调整 REST contract，否则验证计划不要写 201。
- GET list 返回脱敏 `customHeaders`。
- 更新接口支持 masked value 保留逻辑。

---

## 五、前端改造方案

**文件：** `web/admin-spa/src/components/accounts/AccountForm.vue`

### 5.1 form 初始化

新增字段：

```js
boundModel: props.account?.boundModel || '',
modelAliasesText: Array.isArray(props.account?.modelAliases)
  ? props.account.modelAliases.join('\n')
  : '',
supportsTools: props.account?.supportsTools !== false,
supportsImages: props.account?.supportsImages || false,
supportsReasoning: props.account?.supportsReasoning || false,
maxInputTokens: props.account?.maxInputTokens || 0,
maxOutputTokens: props.account?.maxOutputTokens || 0,
customHeadersText: formatCustomHeadersForEdit(props.account?.customHeaders),
```

### 5.2 providerEndpoint 选项统一

创建和编辑两个区域必须一致：

```html
<option value="responses">Responses API</option>
<option value="chat_completions">Chat Completions API</option>
<option value="passthrough">原样转发</option>
<option value="auto">自动/旧版原样转发（兼容旧配置）</option>
```

移除旧的 `value="completions"`。

### 5.3 表单区域

在 OpenAI-Responses 配置区域中新增：

- 上游模型名：`boundModel`
- 客户端模型别名：`modelAliasesText`（可选，多行）
- 支持工具调用 / 图片输入 / reasoning
- 输入/输出 token 上限
- 自定义请求头 JSON

注意：token preset 按钮必须加 `type="button"`，否则会触发表单提交。

```html
<button type="button" @click="form.maxOutputTokens = val">...</button>
```

### 5.4 提交序列化

创建/编辑都提交：

```js
data.boundModel = form.value.boundModel?.trim() || ''
data.modelAliases = form.value.modelAliasesText
  .split('\n')
  .map((v) => v.trim())
  .filter(Boolean)
data.supportsTools = !!form.value.supportsTools
data.supportsImages = !!form.value.supportsImages
data.supportsReasoning = !!form.value.supportsReasoning
data.maxInputTokens = Math.max(0, Number(form.value.maxInputTokens) || 0)
data.maxOutputTokens = Math.max(0, Number(form.value.maxOutputTokens) || 0)
data.customHeaders = parseCustomHeadersText(form.value.customHeadersText)
```

编辑时：

- 不改 headers：可以不传 `customHeaders`。
- 清空 textarea 且用户明确点击“清空自定义请求头”：传 `{}`。
- 值为 `***` 的 key 表示保留原值。

### 5.5 校验

- `customHeadersText` 必须是 JSON object，不能是 array/string。
- header name 必须合法。
- 禁止保留 header 直接在前端提示。
- `providerEndpoint` 必须为合法枚举。
- `boundModel` 和 alias 不允许包含换行、控制字符。

---

## 六、模型预设（可选）

**文件：** `config/models.js`

模型预设只作为 UI 便利，不作为路由真相来源。可新增常用 OpenAI 兼容模型，但要避免把预设当成完整列表。

```js
const OPENAI_COMPATIBLE_MODELS = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  { value: 'qwen-plus', label: 'Qwen Plus' },
  { value: 'qwen-max', label: 'Qwen Max' },
  { value: 'glm-4-plus', label: 'GLM 4 Plus' }
]
```

---

## 七、实施顺序

```
Phase 0（协议与路由）
  ├── 定义 providerEndpoint 枚举和兼容别名
  ├── unified.js 保存原始 Chat Completions 请求
  ├── unknown model / bound responses account 路由到 OpenAI 兼容流
  └── 验证 /openai/v1/chat/completions 不再被错误路由到 Claude

Phase 1（账户字段与安全）
  ├── openaiResponsesAccountService.js 新字段、校验、默认值
  ├── customHeaders 加密存储、脱敏返回、masked update
  ├── admin route 400 错误码处理
  └── Account Service 单元验证

Phase 2（调度）
  ├── scheduler 增加 model rank 匹配
  ├── group / shared pool / sticky session 全路径一致
  ├── 普通 OpenAI 共享账号与 OpenAI-Responses 新逻辑隔离
  ├── requestFeatures 能力过滤
  └── DeepSeek 多模型共享池验证

Phase 3（relay）
  ├── resolveUpstreamRequest 按协议生成 path/body
  ├── boundModel 上游覆盖
  ├── 能力校验/降级与 max token 钳制
  ├── 安全 customHeaders 注入
  └── mock upstream 捕获 path/body/header 验证

Phase 4（前端）
  ├── providerEndpoint 选项统一
  ├── 新增模型/能力/token/header 表单
  ├── 创建/编辑序列化和校验
  └── 管理后台回显/清空 header 验证
```

---

## 八、验证计划

### 8.1 路由与协议验证

| 编号 | 场景 | 预期 |
|------|------|------|
| R-01 | `/openai/v1/chat/completions`，API Key 绑定 `responses:<id>`，账号 `chat_completions` | 上游收到 `/v1/chat/completions` 和原始 `messages` body |
| R-02 | `/openai/v1/chat/completions`，账号 `responses` | 上游收到 `/v1/responses` 和转换后的 `input` body |
| R-03 | `/openai/v1/chat/completions`，未知 model 但匹配 `boundModel` | 进入 OpenAI 兼容流，不进入 Claude |
| R-04 | `/api/v1/chat/completions`，未知 model 且无 OpenAI 兼容匹配 | 保持现有默认路由行为 |
| R-05 | `/openai/v1/responses`，账号 `chat_completions` | 上游收到 `/v1/chat/completions` 和转换后的 Chat Completions body |

### 8.2 Account Service 验证

| 编号 | 场景 | 预期 |
|------|------|------|
| A-01 | 创建时传 `boundModel=' deepseek-chat '` | Redis 存储 trim 后值 |
| A-02 | 创建时传 `providerEndpoint='completions'` | 返回 400，提示应使用 `chat_completions` |
| A-03 | 创建时传 customHeaders | Redis 中为加密值，GET list 返回脱敏 |
| A-04 | 更新 customHeaders 中某 key 为 `***` | 保留旧值 |
| A-05 | customHeaders 包含 `Authorization` | 返回 400 或忽略并 warn，按最终策略一致验证 |
| A-06 | 旧账户不含新字段 | getAccount 返回默认值，行为不变 |

### 8.3 Scheduler 验证

| 编号 | 账户池 | 请求 model | 预期 |
|------|--------|------------|------|
| S-01 | A(boundModel=deepseek-chat), C(未绑定) | deepseek-chat | 优先选 A |
| S-02 | A(boundModel=deepseek-chat), C(未绑定) | unknown-model | 选 C |
| S-03 | A(boundModel=deepseek-chat) | unknown-model | 无可用账户，400 |
| S-04 | API Key 专属绑定 A(boundModel=deepseek-chat) | anything | 选 A，relay 覆盖为 deepseek-chat |
| S-05 | sticky session 绑定 A 后请求不匹配 model | 删除旧 mapping 并重新调度 |
| S-06 | 请求含 tools，A supportsTools=false，B supportsTools=true | 选 B |
| S-07 | 普通 OpenAI 共享账号配置不含新字段 | 仍按原 `supportedModels` / priority / lastUsedAt 逻辑选择，不参与 `boundModel` 过滤 |

### 8.4 Relay 验证

| 编号 | 场景 | 预期 |
|------|------|------|
| L-01 | Chat Completions 上游，boundModel 非空 | 上游 body.model 被覆盖 |
| L-02 | Responses 上游，boundModel 非空 | 上游 body.model 被覆盖 |
| L-03 | maxOutputTokens=8192，Chat body max_tokens=100000 | 上游 max_tokens=8192 |
| L-04 | maxOutputTokens=8192，Responses body max_output_tokens=100000 | 上游 max_output_tokens=8192 |
| L-05 | customHeaders 含 `X-API-Key` | 上游 header 包含该 key，日志不含 value |
| L-06 | customHeaders 试图覆盖 Authorization | 上游 Authorization 仍为账户 apiKey |
| L-07 | supportsReasoning=false 且请求含 reasoning | 默认返回 400 或按策略删除，行为固定可测 |

### 8.5 前端验证

| 编号 | 场景 | 预期 |
|------|------|------|
| F-01 | 创建 OpenAI-Responses 账户 | providerEndpoint 可选 `responses` / `chat_completions` / `passthrough` / `auto` |
| F-02 | 编辑含 customHeaders 的账户 | 显示脱敏值，不泄露 secret |
| F-03 | 点击 token preset | 不触发表单提交 |
| F-04 | 非法 JSON customHeaders | 前端阻止提交并提示 |
| F-05 | 清空 customHeaders | 需要明确操作，避免误删 |

### 8.6 端到端场景

#### E-01：DeepSeek Chat Completions

```
baseApi=https://api.deepseek.com/v1
providerEndpoint=chat_completions
boundModel=deepseek-chat
supportsTools=true/false 按账号配置
```

- `/openai/v1/chat/completions` 请求 `model=deepseek-chat` 成功。
- 请求 `model=anything` 只有在 API Key 专属绑定该账户时成功，并覆盖为 `deepseek-chat`。
- stream=true 返回标准 SSE。
- mock upstream 断言 path/body/header 正确。

#### E-02：OpenAI Responses 兼容 provider

```
baseApi=https://example-provider/v1
providerEndpoint=responses
boundModel=<provider-responses-model>
```

- `/openai/v1/responses` 原样 Responses body 转发。
- `/openai/v1/chat/completions` 转换为 Responses body 后转发。
- usage 能被现有统计逻辑记录。

#### E-03：多模型共享池

```
账户A：boundModel=deepseek-chat, providerEndpoint=chat_completions
账户B：boundModel=deepseek-reasoner, providerEndpoint=chat_completions
账户C：boundModel='', providerEndpoint=chat_completions
```

| 请求 model | 预期 |
|------------|------|
| deepseek-chat | A |
| deepseek-reasoner | B |
| qwen-plus | C |
| unknown-model | C |

---

## 九、风险与决策点

| 决策点 | 建议 |
|--------|------|
| 不支持 tools/images/reasoning 时是删除还是拒绝 | 默认拒绝 400；后续可加 `capabilityPolicy=strip` |
| 专属账户是否强制模型匹配 | 默认不强制；boundModel 作为 override |
| shared pool 是否允许未绑定兜底 | 允许，但精确/别名匹配优先 |
| customHeaders 是否允许覆盖 Authorization | 默认禁止；如需特殊认证另设字段 |
| `auto` 是否保留 | 保留为 `passthrough` alias，避免旧配置失效 |
| `/api/*` 未知模型默认路由是否改变 | 不改变；仅 `/openai/*` 优先 OpenAI 兼容 fallback |
| 普通 OpenAI 共享账号是否参与新匹配逻辑 | 不参与；新字段和能力过滤只作用于 `openai-responses` |

---

## 十、回滚方案

本改造不再是完全“只加字段”的纯增量改造，因为会触及路由和调度。建议提供以下回滚手段：

- 配置开关：`ENABLE_OPENAI_COMPATIBLE_ROUTING=false` 时，恢复现有 `unified.js` 路由行为。
- `auto` 保留为旧版语义别名，旧账户不需要迁移。
- 新字段留在 Redis 中无副作用；禁用 routing 后不会被使用。
- 如需代码回滚，优先回滚 Phase 0/2/3 的路由与调度改动；账户字段可以保留。

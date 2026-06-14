# gpt-image-2 图片 API 支持规划

> 目标：在现有 `claude-relay-service` 中新增 OpenAI Images API 的图片生成/编辑中继能力，并让 Responses API 的 `image_generation` 工具参与同一套账户能力调度；默认不破坏现有 Responses / Chat Completions 链路。

## 1. 背景与边界

### 1.1 已确认的 API 面

当前设计只以 OpenAI 官方文档中稳定公开的 Images API/Responses API 形态为依据：

| 能力           | 路径                                                           | MVP 支持策略                                                                   |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 文生图         | `POST /v1/images/generations`                                  | 支持 JSON 非流式请求；`stream: true` 先显式拒绝，后续单独做 SSE/partial images |
| 图片编辑       | `POST /v1/images/edits`                                        | 支持 `multipart/form-data` 原始流透传；JSON data URI 编辑不作为 MVP 承诺       |
| Responses 协作 | `POST /v1/responses` + `tools: [{ type: "image_generation" }]` | 不新增路由，但调度时必须识别为图片生成能力请求                                 |

不再在设计文档中硬编码未实现或未核实的产品断言，例如发布时间、DALL-E 退役状态、文字准确率、最大分辨率、`thinking` 参数等。实现层应透传未知字段，但文档只承诺已纳入本项目设计的能力。

### 1.2 当前工程现状

现有 OpenAI 请求链路：

```text
客户端 -> /openai/v1/responses -> openaiRoutes.js -> handleResponses()
  -> getOpenAIAuthToken() -> unifiedOpenAIScheduler.selectAccountForApiKey()
  -> openai-responses 账户: openaiResponsesRelayService.handleRequest()
  -> 普通 openai 账户: chatgpt.com Codex API
```

关键约束：

- `src/app.js` 全局只解析 JSON/urlencoded；multipart 请求不会进入 `req.body`，图片编辑不能按 JSON handler 设计。
- `providerEndpoint` 目前是单值文本协议选择：`responses` / `chat_completions` / `passthrough` / `auto`。
- `boundModel` 当前服务文本上游模型覆盖；不能无条件拿来覆盖图片模型。
- 现有费用链路以文本 token 为中心；不能用普通 input/output token 粗暴估算图片费用。

---

## 2. 修订后的架构

### 2.1 请求流

```text
客户端
  |
  |-- POST /openai/v1/images/generations
  |-- POST /openai/images/generations
  |     -> openaiRoutes.js 新增 handleImageGenerations()
  |     -> getOpenAIAuthToken(endpointKind="images", hasImageGeneration=true)
  |     -> unifiedOpenAIScheduler 选择 supportsImageGeneration=true 的 openai-responses 账户
  |     -> openaiImageRelayService.handleGenerations()
  |     -> 上游 {baseApi}/v1/images/generations
  |
  |-- POST /openai/v1/images/edits
  |-- POST /openai/images/edits
  |     -> openaiRoutes.js 新增 handleImageEdits()
  |     -> multipart 原始流透传到上游 /v1/images/edits
  |
  |-- POST /openai/v1/responses
        -> 现有 handleResponses()
        -> 若 tools 包含 image_generation，则调度必须要求 supportsImageGeneration=true
```

### 2.2 设计原则

1. **不新增 `providerEndpoint=images`**：Images API 是账户能力叠加，不是替代文本协议的单值 provider 协议。
2. **图片能力显式开关**：使用 `supportsImageGeneration` 隔离支持图片的 OpenAI-compatible 账户。
3. **模型覆盖分离**：图片请求不使用文本 `boundModel`；如需覆盖图片模型，使用图片专用字段。
4. **multipart 单独处理**：编辑接口按流式文件上传设计，不假设 `req.body` 存在。
5. **费用不估算入账**：优先使用上游 `usage`；无 usage 时记录 0 token/0 cost 请求并告警，不用拍脑袋 token 估算影响额度。

---

## 3. 实施层次

### 第 1 层：扩展 OpenAI 兼容工具函数

**文件**：`src/utils/openaiCompatible.js`

#### 3.1.1 `VALID_PROVIDER_ENDPOINTS` 保持不变

不要添加 `images`：

```js
const VALID_PROVIDER_ENDPOINTS = ['responses', 'chat_completions', 'passthrough', 'auto']
```

原因：`providerEndpoint` 表示文本请求上游协议。若把账户改成 `images`，同一个账户会失去 Responses / Chat Completions 调度资格。

#### 3.1.2 识别 Images API 路径

```js
function detectEndpointKindFromPath(path = '') {
  if (path === '/v1/images/generations' || path === '/images/generations') {
    return 'images'
  }
  if (path === '/v1/images/edits' || path === '/images/edits') {
    return 'images'
  }
  // existing branches...
}
```

#### 3.1.3 识别 Responses `image_generation` 工具

新增递归或数组扫描函数：

```js
function containsImageGenerationTool(body = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.some((tool) => tool && tool.type === 'image_generation')
}
```

扩展 `getRequestFeaturesFromBody()`：

```js
function getRequestFeaturesFromBody(body = {}, endpointKind = null) {
  return {
    endpointKind: endpointKind || detectEndpointKindFromPath(''),
    hasTools:
      hasValue(body.tools) ||
      body.tool_choice !== undefined ||
      body.parallel_tool_calls !== undefined,
    hasImages: containsImagePayload(body.messages || body.input || body),
    hasReasoning: containsReasoningPayload(body),
    hasImageGeneration: containsImageGenerationTool(body)
  }
}
```

#### 3.1.4 新增 Images API 请求特征

```js
function getRequestFeaturesForImages(body = {}, options = {}) {
  return {
    endpointKind: 'images',
    hasTools: false,
    hasImages: false,
    hasReasoning: false,
    hasImageGeneration: true,
    imageOperation: options.operation || 'generations',
    imageModel: body?.model || options.defaultModel || 'gpt-image-2',
    openaiResponsesOnly: true
  }
}
```

对于 multipart edits，`body` 可能为空；调度层应接受默认模型或通用图片能力匹配。

#### 3.1.5 `endpointSupportsKind()` 不把 images 作为 provider 协议

```js
function endpointSupportsKind(providerEndpoint = 'responses', endpointKind = 'responses') {
  const protocol = getProviderProtocol(providerEndpoint)

  if (endpointKind === 'images') {
    return protocol === 'responses' || protocol === 'passthrough'
  }

  // existing responses/chat_completions/passthrough branches...
}
```

`auto` 会通过 `getProviderProtocol()` 归一到 `passthrough`。

#### 3.1.6 `accountSupportsRequestFeatures()` 增加图片能力过滤

```js
if (features.hasImageGeneration && account.supportsImageGeneration !== true) {
  return { ok: false, reason: 'image_generation_not_supported' }
}
```

---

### 第 2 层：扩展账户模型

**文件**：`src/services/account/openaiResponsesAccountService.js`

#### 3.2.1 新增字段

```js
supportsImageGeneration = false
imageBoundModel = ''
imageModelAliases = []
```

落库字段：

```js
supportsImageGeneration: this._normalizeBoolean(supportsImageGeneration, false),
imageBoundModel: this._normalizeBoundModel(imageBoundModel),
imageModelAliases: JSON.stringify(this._normalizeStringList(imageModelAliases))
```

字段语义：

- `supportsImageGeneration`：账户是否可被图片生成/编辑或 Responses `image_generation` 工具选中。
- `imageBoundModel`：仅图片 API 使用的上游模型覆盖；不复用文本 `boundModel`。
- `imageModelAliases`：客户端可请求的图片模型别名；为空时表示图片能力不按模型名收窄。

#### 3.2.2 更新与反序列化

`updateAccount()` 增加新字段规范化；`_hydrateOpenAICompatibleFields()` 输出默认值：

```js
accountData.supportsImageGeneration =
  accountData.supportsImageGeneration === true || accountData.supportsImageGeneration === 'true'
accountData.imageBoundModel = accountData.imageBoundModel || ''
accountData.imageModelAliases = this._normalizeStringList(accountData.imageModelAliases)
```

Redis 老数据中字段不存在时应保持 `false` / 空字符串 / 空数组。

---

### 第 3 层：扩展调度器

**文件**：`src/services/scheduler/unifiedOpenAIScheduler.js`

#### 3.3.1 `_normalizeRequestFeatures()` 增加图片字段

```js
_normalizeRequestFeatures(requestFeatures = {}) {
  return {
    endpointKind: requestFeatures.endpointKind || 'responses',
    hasTools: requestFeatures.hasTools === true,
    hasImages: requestFeatures.hasImages === true,
    hasReasoning: requestFeatures.hasReasoning === true,
    hasImageGeneration: requestFeatures.hasImageGeneration === true,
    imageOperation: requestFeatures.imageOperation || '',
    imageModel: requestFeatures.imageModel || null,
    openaiResponsesOnly: requestFeatures.openaiResponsesOnly === true
  }
}
```

#### 3.3.2 增加图片模型匹配

新增工具函数，避免图片请求被文本 `boundModel` 拦截：

```js
function getOpenAIImageModelRank(account = {}, requestedModel = null) {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const boundModel =
    typeof account.imageBoundModel === 'string' ? account.imageBoundModel.trim() : ''
  const aliases = normalizeStringArray(account.imageModelAliases)

  if (!model) return 1
  if (boundModel && model === boundModel) return 3
  if (aliases.includes(model)) return 2
  if (!boundModel && aliases.length === 0) return 1
  return 0
}
```

`_rankOpenAIResponsesAccount()` 规则：

- `endpointKind === 'images'`：先做 `accountSupportsRequestFeatures()`，再用 `getOpenAIImageModelRank()`。
- `endpointKind !== 'images' && hasImageGeneration === true`：仍按文本模型 `boundModel/modelAliases` 匹配，但额外要求 `supportsImageGeneration=true`。
- 普通 Responses / Chat Completions 请求不受影响。

---

### 第 4 层：新增图片中继服务

**新文件**：`src/services/relay/openaiImageRelayService.js`

#### 3.4.1 职责

- 转发 `/v1/images/generations` JSON 请求。
- 转发 `/v1/images/edits` multipart 请求。
- 复用 OpenAI-Responses 账户的 `baseApi/apiKey/proxy/userAgent/customHeaders`。
- 复用现有上游错误保护：429/401/5xx 临时不可用、session mapping 清理、错误脱敏。
- 记录图片 usage 和费用；无 usage 时记录 0 并告警。

#### 3.4.2 文生图非流式处理

MVP 明确不支持图片流式：

```js
if (req.body?.stream === true) {
  return res.status(400).json({
    error: {
      message: 'Image streaming is not supported by this relay yet',
      type: 'invalid_request_error',
      code: 'image_stream_not_supported'
    }
  })
}
```

模型处理：

```js
const body = clonePlainObject(req.body || {})
const requestedModel = body.model || 'gpt-image-2'
const upstreamModel = fullAccount.imageBoundModel?.trim() || requestedModel
body.model = upstreamModel
```

不要使用 `fullAccount.boundModel` 覆盖图片模型。

#### 3.4.3 图片编辑 multipart 处理

MVP 支持 `multipart/form-data` 原始流透传：

- 不依赖 `req.body`。
- 透传原始请求流到上游 `/v1/images/edits`。
- 上游 header 使用原始 `Content-Type` 的 boundary，覆盖 `Authorization`，不要转发客户端 `content-length`。
- 不在 request detail 中保存文件内容；只保存 `contentType/contentLength/modelHint` 等元数据。
- `imageBoundModel` 不应用于 raw multipart edits；若需要覆盖 multipart 中的 `model` 字段，后续阶段再引入 busboy/form-data 重建请求。

非 multipart 请求返回 415：

```js
return res.status(415).json({
  error: {
    message: 'Image edits require multipart/form-data in MVP',
    type: 'invalid_request_error',
    code: 'unsupported_media_type'
  }
})
```

#### 3.4.4 目标 URL 与 headers

复用 `openaiResponsesRelayService` 的 `_stripDuplicatedVersionPath()` 思路，避免 `baseApi=https://api.openai.com/v1` 时拼成 `/v1/v1/...`。

JSON generations headers：

```js
{
  ...filterForOpenAI(req.headers),
  Authorization: `Bearer ${fullAccount.apiKey}`,
  'Content-Type': 'application/json'
}
```

multipart edits headers：

```js
{
  ...filterForOpenAI(req.headers),
  Authorization: `Bearer ${fullAccount.apiKey}`,
  'Content-Type': req.headers['content-type']
}
```

两类请求都要应用 `userAgent` 和非保留 `customHeaders`。

#### 3.4.5 错误处理

图片中继服务应复制现有 OpenAI-Responses relay 的行为，而不是只返回通用 500：

- 429：解析 `Retry-After` / body reset 信息，调用 `unifiedOpenAIScheduler.markAccountRateLimited()`，并按 `disableAutoProtection` 决定是否 `upstreamErrorHelper.markTempUnavailable()`。
- 401/403：临时标记不可用，返回上游脱敏错误。
- 5xx/网络错误：临时标记不可用。
- 成功后节流更新 `lastUsedAt`。
- 所有 `req/res close` listener 放在 `finally` 清理。

---

### 第 5 层：图片用量与费用

现有 `recordUsage()` 和 `CostCalculator.calculateCost()` 只适合文本 token。图片 API 必须新增图片 usage 路径。

#### 3.5.1 新增内部图片 usage 结构

```js
{
  kind: 'image',
  inputTextTokens: 0,
  inputImageTokens: 0,
  outputImageTokens: 0,
  cacheReadTextTokens: 0,
  cacheReadImageTokens: 0,
  totalTokens: 0,
  rawUsage: {}
}
```

从上游 usage 映射时，优先读取官方返回字段；字段缺失时置 0，不估算。

#### 3.5.2 新增费用计算函数

**文件**：`src/utils/costCalculator.js`

新增：

```js
CostCalculator.calculateImageCost(imageUsage, model)
```

价格字段使用本项目现有 LiteLLM schema：

- `input_cost_per_token`：文本输入 token。
- `input_cost_per_image_token`：图片输入 token。
- `output_cost_per_image_token`：图片输出 token。
- `cache_read_input_token_cost` / `cache_read_input_image_token_cost`：缓存读取。

不要使用 `input_price_per_million_tokens` / `output_price_per_million_tokens` 这类本项目未读取的字段。

#### 3.5.3 新增记录入口

**文件**：`src/services/apiKeyService.js`

新增或等价扩展：

```js
apiKeyService.recordImageUsage({
  keyId,
  imageUsage,
  model,
  accountId,
  accountType: 'openai-responses',
  requestMeta
})
```

行为：

- token 统计使用 `imageUsage.totalTokens`。
- 费用使用 `CostCalculator.calculateImageCost()`。
- request detail 标记 `usageKind: 'image'` 并保存脱敏请求信息。
- daily quota 使用图片真实费用更新。
- rate limit counters 使用预计算费用，避免再次走文本费用计算。

#### 3.5.4 无 usage 降级

如果上游未返回 usage：

- 记录一次成功请求，token/cost 均为 0。
- 写 warning 日志，包含 model、operation、accountId。
- 不做 token 估算，不更新费用额度。

---

### 第 6 层：新增路由

**文件**：`src/routes/openaiRoutes.js`

新增依赖：

```js
const openaiImageRelayService = require('../services/relay/openaiImageRelayService')
const { getRequestFeaturesForImages } = require('../utils/openaiCompatible')
```

#### 3.6.1 `handleImageGenerations()`

核心逻辑：

```js
const body = req.body || {}
if (!body.model) body.model = 'gpt-image-2'

const requestFeatures = getRequestFeaturesForImages(body, { operation: 'generations' })
const { accountType, account } = await getOpenAIAuthToken(
  apiKeyData,
  null,
  body.model,
  requestFeatures
)

if (accountType !== 'openai-responses') {
  return unsupportedAccountType()
}

return openaiImageRelayService.handleGenerations(req, res, account, apiKeyData)
```

#### 3.6.2 `handleImageEdits()`

核心逻辑：

```js
if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
  return unsupportedMediaType()
}

const requestFeatures = getRequestFeaturesForImages(null, {
  operation: 'edits',
  defaultModel: 'gpt-image-2'
})

const { accountType, account } = await getOpenAIAuthToken(
  apiKeyData,
  null,
  requestFeatures.imageModel,
  requestFeatures
)

return openaiImageRelayService.handleEdits(req, res, account, apiKeyData)
```

#### 3.6.3 路由注册

```js
router.post('/images/generations', authenticateApiKey, handleImageGenerations)
router.post('/v1/images/generations', authenticateApiKey, handleImageGenerations)
router.post('/images/edits', authenticateApiKey, handleImageEdits)
router.post('/v1/images/edits', authenticateApiKey, handleImageEdits)
```

`unifiedRoutes` 当前只拦截 `/v1/chat/completions` 和 `/v1/completions`，不会吞掉新增 images 路由。

---

## 4. 管理后台适配

### 4.1 账户表单

**文件**：`web/admin-spa/src/components/accounts/AccountForm.vue`

在 OpenAI-Responses 字段组中新增：

- `支持图片生成`：`supportsImageGeneration`。
- `图片上游模型名`：`imageBoundModel`，可选。
- `图片模型别名`：`imageModelAliasesText`，可选，每行一个。

`Provider 端点类型` 下拉不要新增 `images` 选项。

### 4.2 账户列表

**文件**：`web/admin-spa/src/views/AccountsView.vue`

在 OpenAI-Responses 账户卡片中展示图片能力标签，例如：

- `Image API`
- `imageBoundModel` 非空时展示模型名

### 4.3 管理后台 API

**文件**：`src/routes/admin/openaiResponsesAccounts.js`

CRUD 当前会透传请求体到 service，但仍需依赖 service 层校验/规范化新增字段。无需新增独立接口。

---

## 5. 定价配置

**文件**：`resources/model-pricing/model_prices_and_context_window.json`

已按 OpenAI Pricing 页面确认 `gpt-image-2` 的 Images API token 价格，并使用项目已有 LiteLLM schema：

```json
{
  "gpt-image-2": {
    "litellm_provider": "openai",
    "mode": "image_generation",
    "input_cost_per_token": 0.000005,
    "input_cost_per_image_token": 0.000008,
    "output_cost_per_image_token": 0.00003,
    "cache_read_input_token_cost": 0.00000125,
    "cache_read_input_image_token_cost": 0.000002,
    "source": "https://developers.openai.com/api/docs/pricing",
    "supported_endpoints": ["/v1/images/generations", "/v1/images/edits"]
  }
}
```

不要使用旧计划中的 `input_price_per_million_tokens` / `output_price_per_million_tokens`，因为现有 `pricingService` 不读取这些字段。

---

## 6. 向后兼容保障

| 风险                                      | 保障                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| 文本账户被图片请求误选                    | 图片请求必须 `supportsImageGeneration=true`                 |
| 图片能力破坏文本 provider 协议            | 不新增 `providerEndpoint=images`，保留原有枚举              |
| 文本 `boundModel` 覆盖图片模型            | 图片 API 使用 `imageBoundModel`，不复用 `boundModel`        |
| multipart 文件被错误解析/记录             | edits 原始流透传，request detail 不保存文件内容             |
| 无 usage 时额度错扣                       | 无 usage 记录 0，不估算费用                                 |
| Responses `image_generation` 工具选错账户 | `getRequestFeaturesFromBody()` 识别工具并要求图片能力       |
| 官方 stream 参数被悄悄忽略                | MVP 对 `stream: true` 显式返回 `image_stream_not_supported` |

---

## 7. 测试计划

### 7.1 单元测试

- `openaiCompatible.js`：图片路径识别为 `endpointKind='images'`。
- `openaiCompatible.js`：`tools: [{ type: 'image_generation' }]` 识别 `hasImageGeneration=true`。
- `openaiCompatible.js`：`endpointKind='images'` 不要求 `providerEndpoint='images'`。
- `unifiedOpenAIScheduler.js`：`supportsImageGeneration=false` 的账户不会被图片请求选中。
- `unifiedOpenAIScheduler.js`：图片请求使用 `imageBoundModel/imageModelAliases`，不被文本 `boundModel` 拦截。
- `costCalculator.js`：`calculateImageCost()` 正确使用 text/image input/output token 价格。

### 7.2 集成测试

- `/openai/v1/images/generations` 非流式 JSON 完整链路。
- `/openai/v1/images/generations` + `stream:true` 返回 400 `image_stream_not_supported`。
- `/openai/v1/images/edits` multipart 文件上传透传，不依赖 `req.body`。
- `/openai/v1/images/edits` JSON 请求返回 415。
- `/openai/v1/responses` 携带 `image_generation` 工具时只选择图片能力账户。
- 429/401/5xx 与网络错误会临时保护账户并返回脱敏错误。
- 成功但无 usage 时记录 0 usage 并输出 warning。

### 7.3 回归测试

- 现有 `/openai/v1/responses` 非图片请求调度不变。
- 现有 `/openai/v1/chat/completions` 经 `unifiedRoutes` 调度不变。
- OpenAI-Responses 账户 CRUD 对旧数据兼容。
- 价格文件加载与文本模型费用计算不受影响。

---

## 8. 实施顺序

| 步骤 | 文件                                                           | 改动类型           | 风险 |
| ---- | -------------------------------------------------------------- | ------------------ | ---- |
| 1    | `src/utils/openaiCompatible.js`                                | 请求特征与路径识别 | 低   |
| 2    | `src/services/account/openaiResponsesAccountService.js`        | 图片能力字段       | 低   |
| 3    | `src/services/scheduler/unifiedOpenAIScheduler.js`             | 图片能力与模型调度 | 中   |
| 4    | `src/utils/costCalculator.js`                                  | 图片费用计算       | 中   |
| 5    | `src/services/apiKeyService.js`                                | 图片 usage 记录    | 中   |
| 6    | `src/services/relay/openaiImageRelayService.js`                | 新中继服务         | 中   |
| 7    | `src/routes/openaiRoutes.js`                                   | 新增 images 路由   | 低   |
| 8    | `resources/model-pricing/model_prices_and_context_window.json` | 定价配置           | 中   |
| 9    | `web/admin-spa/src/components/accounts/AccountForm.vue`        | 表单字段           | 低   |
| 10   | `web/admin-spa/src/views/AccountsView.vue`                     | 能力展示           | 低   |
| 11   | `tests/*`                                                      | 单元/集成/回归     | 中   |

---

## 9. API 使用示例

### 9.1 文生图

```bash
curl -X POST http://localhost:3000/openai/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A minimalist logo for a tech startup, clean lines, blue and white",
    "size": "1024x1024",
    "quality": "high",
    "n": 1
  }'
```

### 9.2 图片编辑

```bash
curl -X POST http://localhost:3000/openai/v1/images/edits \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "model=gpt-image-2" \
  -F "prompt=Change the background to a sunset beach scene" \
  -F "image=@input.png" \
  -F "size=1024x1024" \
  -F "quality=high"
```

### 9.3 Responses API 协作

```bash
curl -X POST http://localhost:3000/openai/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Generate an image of a futuristic city",
    "tools": [{ "type": "image_generation" }]
  }'
```

此路径不需要新增 image route，但调度器必须把它识别为 `hasImageGeneration=true`，否则可能选到不支持图片生成的账户。

---

## 10. 后续阶段

- 支持 Images API `stream: true` 和 partial images SSE 转发。
- 对 multipart edits 引入 busboy/form-data 重建请求，以支持 `imageBoundModel` 覆盖、字段级审计和更完整的 request detail。
- 支持图片结果存储/下载代理，避免大体积 base64 长期写入日志或详情。
- 增加按图片张数、尺寸、质量维度的统计展示，但费用仍以官方 usage token 为准。

## 参考资料

- OpenAI Image Generation guide: https://developers.openai.com/api/docs/guides/image-generation
- OpenAI Images API reference: https://developers.openai.com/api/reference/resources/images
- OpenAI Pricing: https://developers.openai.com/api/docs/pricing

const VALID_PROVIDER_ENDPOINTS = ['responses', 'chat_completions', 'passthrough', 'auto']
const RESERVED_CUSTOM_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'cookie',
  'set-cookie',
  'proxy-authorization'
])

function createOpenAICompatibleError(message, statusCode = 400, code = 'invalid_request_error') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function validateProviderEndpoint(providerEndpoint) {
  if (!VALID_PROVIDER_ENDPOINTS.includes(providerEndpoint)) {
    throw createOpenAICompatibleError(
      `Invalid providerEndpoint: ${providerEndpoint}. Must be one of: ${VALID_PROVIDER_ENDPOINTS.join(', ')}`
    )
  }
  return providerEndpoint
}

function normalizeProviderEndpoint(providerEndpoint = 'responses') {
  return VALID_PROVIDER_ENDPOINTS.includes(providerEndpoint) ? providerEndpoint : 'responses'
}

function getProviderProtocol(providerEndpoint = 'responses') {
  const normalized = normalizeProviderEndpoint(providerEndpoint)
  return normalized === 'auto' ? 'passthrough' : normalized
}

function clonePlainObject(value) {
  if (value === undefined || value === null) {
    return value
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // Fall through to JSON cloning for plain request bodies.
    }
  }
  return JSON.parse(JSON.stringify(value))
}

function detectEndpointKindFromPath(path = '') {
  if (path === '/v1/chat/completions' || path === '/chat/completions') {
    return 'chat_completions'
  }
  if (
    path === '/v1/images/generations' ||
    path === '/images/generations' ||
    path === '/v1/images/edits' ||
    path === '/images/edits'
  ) {
    return 'images'
  }
  if (
    path === '/responses' ||
    path === '/v1/responses' ||
    path === '/responses/compact' ||
    path === '/v1/responses/compact'
  ) {
    return 'responses'
  }
  return 'passthrough'
}

function isOpenAINamespace(req) {
  return (
    (req.baseUrl && req.baseUrl.startsWith('/openai')) ||
    (req.originalUrl && req.originalUrl.startsWith('/openai/'))
  )
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return value !== undefined && value !== null && value !== false
}

function containsImagePayload(value) {
  if (!value) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsImagePayload(item))
  }
  if (typeof value !== 'object') {
    return false
  }

  const type = typeof value.type === 'string' ? value.type : ''
  if (type === 'image_url' || type === 'input_image' || type === 'image') {
    return true
  }
  if (value.image_url || value.input_image) {
    return true
  }

  return Object.values(value).some((item) => containsImagePayload(item))
}

function containsReasoningPayload(body = {}) {
  if (!body || typeof body !== 'object') {
    return false
  }
  if (hasValue(body.reasoning) || hasValue(body.reasoning_effort)) {
    return true
  }
  if (Array.isArray(body.include)) {
    return body.include.some(
      (item) => typeof item === 'string' && item.toLowerCase().includes('reasoning')
    )
  }
  return false
}

function containsImageGenerationTool(body = {}) {
  if (!body || typeof body !== 'object') {
    return false
  }

  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.some((tool) => tool && tool.type === 'image_generation')
}

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

function getRequestFeaturesForImages(body = {}, options = {}) {
  const features = {
    endpointKind: 'images',
    hasTools: false,
    hasImages: false,
    hasReasoning: false,
    hasImageGeneration: true,
    imageOperation: options.operation || 'generations',
    imageModel: body?.model || options.defaultModel || 'gpt-image-2'
  }
  // generations 允许 token 账号（codex/responses + image_generation 工具）；
  // edits 仅 responses 账号支持（codex image_generation 工具不支持图生图）
  if (options.responsesOnly === true) {
    features.openaiResponsesOnly = true
  }
  return features
}

function normalizeStringArray(value) {
  if (!value) {
    return []
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return normalizeStringArray(parsed)
      }
    } catch {
      // Treat non-JSON strings as a single alias.
    }
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  return []
}

function getOpenAIResponsesModelRank(account = {}, requestedModel = null) {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const boundModel = typeof account.boundModel === 'string' ? account.boundModel.trim() : ''
  const aliases = normalizeStringArray(account.modelAliases)
  const modelKey = model.toLowerCase()
  const boundModelKey = boundModel.toLowerCase()
  const aliasKeys = aliases.map((alias) => alias.toLowerCase())

  if (!model) {
    return 1
  }
  if (boundModel && modelKey === boundModelKey) {
    return 3
  }
  if (aliasKeys.includes(modelKey)) {
    return 2
  }
  if (!boundModel) {
    return 1
  }
  return 0
}

function getOpenAIImageModelRank(account = {}, requestedModel = null) {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const boundModel =
    typeof account.imageBoundModel === 'string' ? account.imageBoundModel.trim() : ''
  const aliases = normalizeStringArray(account.imageModelAliases)
  const modelKey = model.toLowerCase()
  const boundModelKey = boundModel.toLowerCase()
  const aliasKeys = aliases.map((alias) => alias.toLowerCase())

  if (!model) {
    return 1
  }
  if (boundModel && modelKey === boundModelKey) {
    return 3
  }
  if (aliasKeys.includes(modelKey)) {
    return 2
  }
  if (!boundModel && aliases.length === 0) {
    return 1
  }
  return 0
}

function endpointSupportsKind(providerEndpoint = 'responses', endpointKind = 'responses') {
  const normalizedEndpoint = normalizeProviderEndpoint(providerEndpoint)
  const protocol = getProviderProtocol(providerEndpoint)
  if (endpointKind === 'images') {
    return protocol === 'responses'
  }
  if (endpointKind === 'responses') {
    return (
      protocol === 'responses' ||
      protocol === 'chat_completions' ||
      protocol === 'passthrough' ||
      normalizedEndpoint === 'auto'
    )
  }
  if (endpointKind === 'chat_completions') {
    return (
      protocol === 'responses' || protocol === 'chat_completions' || normalizedEndpoint === 'auto'
    )
  }
  return protocol === 'passthrough'
}

function accountSupportsRequestFeatures(account = {}, features = {}) {
  const endpointKind = features.endpointKind || 'responses'
  if (!endpointSupportsKind(account.providerEndpoint || 'responses', endpointKind)) {
    return {
      ok: false,
      reason: `providerEndpoint ${account.providerEndpoint || 'responses'} does not support ${endpointKind}`
    }
  }
  if (features.hasTools && account.supportsTools === false) {
    return { ok: false, reason: 'tools_not_supported' }
  }
  if (features.hasImages && account.supportsImages !== true) {
    return { ok: false, reason: 'images_not_supported' }
  }
  if (features.hasReasoning && account.supportsReasoning !== true) {
    return { ok: false, reason: 'reasoning_not_supported' }
  }
  if (features.hasImageGeneration && account.supportsImageGeneration !== true) {
    return { ok: false, reason: 'image_generation_not_supported' }
  }
  return { ok: true, reason: '' }
}

function isValidHeaderName(name) {
  return typeof name === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

module.exports = {
  VALID_PROVIDER_ENDPOINTS,
  RESERVED_CUSTOM_HEADERS,
  createOpenAICompatibleError,
  validateProviderEndpoint,
  normalizeProviderEndpoint,
  getProviderProtocol,
  clonePlainObject,
  detectEndpointKindFromPath,
  isOpenAINamespace,
  getRequestFeaturesFromBody,
  getRequestFeaturesForImages,
  containsImageGenerationTool,
  normalizeStringArray,
  getOpenAIResponsesModelRank,
  getOpenAIImageModelRank,
  endpointSupportsKind,
  accountSupportsRequestFeatures,
  isValidHeaderName
}

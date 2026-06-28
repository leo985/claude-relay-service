const OPENAI_STYLE_PROVIDERS = new Set([
  'openai',
  'openai-responses',
  'azure-openai',
  'azure_openai',
  'chat_completions',
  'responses'
])

function toTokenNumber(value) {
  if (value === undefined || value === null || value === '') {
    return 0
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }
  return Math.max(0, Math.round(parsed))
}

function firstTokenNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed))
    }
  }
  return 0
}

function hasTokenValue(...values) {
  return values.some((value) => value !== undefined && value !== null && value !== '')
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'string') {
    return 'generic'
  }
  return provider.trim().toLowerCase()
}

function providerInputIncludesCacheRead(provider, override) {
  if (typeof override === 'boolean') {
    return override
  }
  return OPENAI_STYLE_PROVIDERS.has(normalizeProvider(provider))
}

function extractCacheReadTokens(usage = {}) {
  return firstTokenNumber(
    usage.cache_read_input_tokens,
    usage.cacheReadTokens,
    usage.cachedContentTokenCount,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_token,
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_token
  )
}

function extractCacheCreationBreakdown(usage = {}) {
  const cacheCreation =
    usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {}

  const ephemeral5mTokens = firstTokenNumber(
    cacheCreation.ephemeral_5m_input_tokens,
    cacheCreation.cache_creation_input_tokens_ephemeral_5m,
    usage.cache_creation_input_tokens_ephemeral_5m,
    usage.ephemeral_5m_input_tokens,
    usage.ephemeral5mTokens
  )

  const ephemeral1hTokens = firstTokenNumber(
    cacheCreation.ephemeral_1h_input_tokens,
    cacheCreation.cache_creation_input_tokens_ephemeral_1h,
    usage.cache_creation_input_tokens_ephemeral_1h,
    usage.ephemeral_1h_input_tokens,
    usage.ephemeral1hTokens
  )

  return { ephemeral5mTokens, ephemeral1hTokens }
}

function extractCacheCreateTokens(usage = {}) {
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {}
  const { ephemeral5mTokens, ephemeral1hTokens } = extractCacheCreationBreakdown(usage)
  const detailedTotal = ephemeral5mTokens + ephemeral1hTokens

  if (detailedTotal > 0) {
    return detailedTotal
  }

  return firstTokenNumber(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cacheCreateTokens,
    usage.cache_creation_tokens,
    details.cache_creation_input_tokens,
    details.cache_creation_tokens
  )
}

function extractOutputTokens(usage = {}) {
  const outputCandidates = [
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.completionTokens
  ]
  if (hasTokenValue(...outputCandidates)) {
    return firstTokenNumber(...outputCandidates)
  }

  const geminiOutput =
    toTokenNumber(usage.candidatesTokenCount) + toTokenNumber(usage.thoughtsTokenCount)
  if (geminiOutput > 0) {
    return geminiOutput
  }

  const totalTokens = firstTokenNumber(usage.total_tokens, usage.totalTokens, usage.totalTokenCount)
  const promptTokens = firstTokenNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
    usage.total_input_tokens,
    usage.totalInputTokens,
    usage.promptTokenCount
  )

  if (totalTokens > 0 && promptTokens >= 0) {
    return Math.max(0, totalTokens - promptTokens)
  }

  return 0
}

function normalizeUsage(providerOrUsage = 'generic', maybeUsage = {}, maybeOptions = {}) {
  let provider = providerOrUsage
  let usage = maybeUsage
  let options = maybeOptions

  if (typeof providerOrUsage === 'object' && providerOrUsage !== null) {
    provider = 'generic'
    usage = providerOrUsage
    options = maybeUsage || {}
  }

  usage = usage && typeof usage === 'object' ? usage : {}
  options = options && typeof options === 'object' ? options : {}

  const cacheReadTokens = extractCacheReadTokens(usage)
  const cacheCreateTokens = extractCacheCreateTokens(usage)
  const { ephemeral5mTokens, ephemeral1hTokens } = extractCacheCreationBreakdown(usage)

  const totalInputTokens = firstTokenNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
    usage.total_input_tokens,
    usage.totalInputTokens,
    usage.promptTokenCount
  )

  const inputIncludesCacheRead = providerInputIncludesCacheRead(
    provider,
    options.inputIncludesCacheRead
  )
  const inputTokens = Math.max(0, totalInputTokens - (inputIncludesCacheRead ? cacheReadTokens : 0))
  const outputTokens = extractOutputTokens(usage)
  const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
  const providerTotalTokens = firstTokenNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.totalTokenCount
  )

  const normalized = {
    provider: normalizeProvider(provider),
    totalInputTokens,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    ephemeral5mTokens,
    ephemeral1hTokens,
    totalTokens,
    providerTotalTokens
  }

  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
    normalized.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5mTokens,
      ephemeral_1h_input_tokens: ephemeral1hTokens
    }
  }

  return normalized
}

function toAnthropicUsageObject(normalized, baseUsage = {}) {
  const usageObject = {
    ...baseUsage,
    input_tokens: toTokenNumber(normalized?.inputTokens),
    output_tokens: toTokenNumber(normalized?.outputTokens),
    cache_creation_input_tokens: toTokenNumber(normalized?.cacheCreateTokens),
    cache_read_input_tokens: toTokenNumber(normalized?.cacheReadTokens)
  }

  const ephemeral5mTokens = toTokenNumber(normalized?.ephemeral5mTokens)
  const ephemeral1hTokens = toTokenNumber(normalized?.ephemeral1hTokens)
  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
    usageObject.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5mTokens,
      ephemeral_1h_input_tokens: ephemeral1hTokens
    }
  }

  return usageObject
}

module.exports = {
  normalizeUsage,
  toAnthropicUsageObject,
  toTokenNumber,
  extractCacheReadTokens,
  extractCacheCreateTokens,
  extractCacheCreationBreakdown
}

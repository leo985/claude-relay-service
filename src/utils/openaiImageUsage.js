/**
 * OpenAI 图片生成的 usage 解析与汇总工具。
 *
 * codex/responses（token 账号）与标准 /v1/images/generations（responses 账号）
 * 返回的 usage 形态一致（都来自 Responses API 的 image_generation 工具），
 * 因此共用同一套解析逻辑，避免复制粘贴导致实现漂移。
 */

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = toNumber(value)
    if (parsed > 0) {
      return parsed
    }
  }
  return 0
}

// 把上游 usage 对象解析成结构化的图片用量
function extractImageUsage(usageData = {}) {
  if (!usageData || typeof usageData !== 'object') {
    return {
      kind: 'image',
      inputTextTokens: 0,
      inputImageTokens: 0,
      outputImageTokens: 0,
      cacheReadTextTokens: 0,
      cacheReadImageTokens: 0,
      totalTokens: 0,
      rawUsage: usageData || null
    }
  }

  const inputDetails = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const outputDetails = usageData.output_tokens_details || usageData.completion_tokens_details || {}
  const cacheDetails = usageData.cache_read_input_tokens_details || {}

  let inputTextTokens = firstNumber(
    inputDetails.text_tokens,
    inputDetails.input_text_tokens,
    usageData.input_text_tokens,
    usageData.prompt_text_tokens
  )
  const inputImageTokens = firstNumber(
    inputDetails.image_tokens,
    inputDetails.input_image_tokens,
    usageData.input_image_tokens,
    usageData.prompt_image_tokens
  )
  const outputImageTokens = firstNumber(
    outputDetails.image_tokens,
    outputDetails.output_image_tokens,
    usageData.output_image_tokens,
    usageData.output_tokens,
    usageData.completion_tokens
  )
  const cacheReadTextTokens = firstNumber(
    inputDetails.cached_text_tokens,
    cacheDetails.text_tokens,
    usageData.cache_read_text_tokens
  )
  const cacheReadImageTokens = firstNumber(
    inputDetails.cached_image_tokens,
    cacheDetails.image_tokens,
    usageData.cache_read_image_tokens
  )

  if (!inputTextTokens && !inputImageTokens) {
    inputTextTokens = firstNumber(usageData.input_tokens, usageData.prompt_tokens)
  }

  const knownTotal =
    inputTextTokens +
    inputImageTokens +
    outputImageTokens +
    cacheReadTextTokens +
    cacheReadImageTokens
  const totalTokens = firstNumber(usageData.total_tokens, knownTotal)

  return {
    kind: 'image',
    inputTextTokens: inputTextTokens || (knownTotal ? 0 : toNumber(usageData.input_tokens)),
    inputImageTokens,
    outputImageTokens,
    cacheReadTextTokens,
    cacheReadImageTokens,
    totalTokens,
    rawUsage: usageData
  }
}

// 汇总成限流计数器所需的 token 概要
function usageSummaryForRateLimits(imageUsage = {}) {
  const inputTokens = toNumber(imageUsage.inputTextTokens) + toNumber(imageUsage.inputImageTokens)
  const outputTokens = toNumber(imageUsage.outputImageTokens)
  const cacheReadTokens =
    toNumber(imageUsage.cacheReadTextTokens) + toNumber(imageUsage.cacheReadImageTokens)
  return {
    totalInputTokens: inputTokens + cacheReadTokens,
    inputTokens,
    outputTokens,
    cacheCreateTokens: 0,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens
  }
}

module.exports = {
  extractImageUsage,
  usageSummaryForRateLimits
}

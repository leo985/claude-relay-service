const redis = require('../models/redis')
const LRUCache = require('../utils/lruCache')

const HISTORY_DAYS = 30
const CACHE_TTL_MS = 30 * 1000
const MAX_CACHE_ENTRIES = 500
const DAY_MS = 24 * 60 * 60 * 1000

function toInteger(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

class ApiKeyMonthlyUsageService {
  constructor(options = {}) {
    this.redis = options.redis || redis
    this.cache = options.cache || new LRUCache(MAX_CACHE_ENTRIES)
    this.now = options.now || (() => new Date())
    this.inFlight = new Map()
    this.generations = new Map()
  }

  async getUsage(keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('API key ID is required')
    }

    const endDate = this.redis.getDateStringInTimezone(this.now())
    const cacheKey = `${keyId}:${endDate}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)
    }

    const generation = this.generations.get(cacheKey) || 0
    const request = this._loadUsage(keyId)
      .then((result) => {
        if ((this.generations.get(cacheKey) || 0) === generation) {
          this.cache.set(cacheKey, result, CACHE_TTL_MS)
        }
        return result
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === request) {
          this.inFlight.delete(cacheKey)
        }
      })

    this.inFlight.set(cacheKey, request)
    return request
  }

  invalidate(keyId, date = this.redis.getDateStringInTimezone(this.now())) {
    const cacheKey = `${keyId}:${date}`
    this.generations.set(cacheKey, (this.generations.get(cacheKey) || 0) + 1)
    this.inFlight.delete(cacheKey)
    return this.cache.delete(cacheKey)
  }

  async _loadUsage(keyId) {
    const now = this.now()
    const dates = []

    for (let offset = HISTORY_DAYS - 1; offset >= 0; offset--) {
      const date = new Date(now.getTime() - offset * DAY_MS)
      dates.push(this.redis.getDateStringInTimezone(date))
    }

    const client = this.redis.getClientSafe()
    const pipeline = client.pipeline()
    for (const date of dates) {
      pipeline.hgetall(`usage:daily:${keyId}:${date}`)
      pipeline.get(`usage:cost:daily:${keyId}:${date}`)
    }

    const results = await pipeline.exec()
    const history = []
    let totalRequests = 0
    let totalTokens = 0
    let totalCost = 0
    let activeDays = 0

    dates.forEach((date, index) => {
      const [usageError, usageData = {}] = results[index * 2] || []
      const [costError, costValue] = results[index * 2 + 1] || []
      if (usageError || costError) {
        throw usageError || costError
      }

      const inputTokens = toInteger(usageData.inputTokens)
      const outputTokens = toInteger(usageData.outputTokens)
      const cacheCreateTokens = toInteger(usageData.cacheCreateTokens)
      const cacheReadTokens = toInteger(usageData.cacheReadTokens)
      const componentTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
      const tokens = Object.prototype.hasOwnProperty.call(usageData, 'allTokens')
        ? toInteger(usageData.allTokens)
        : componentTokens || toInteger(usageData.tokens)
      const requests = toInteger(usageData.requests)
      const cost = Number(toNumber(costValue).toFixed(6))

      if (requests > 0 || tokens > 0 || cost > 0) {
        activeDays += 1
      }

      totalRequests += requests
      totalTokens += tokens
      totalCost += cost

      history.push({
        date,
        label: date.slice(5).replace('-', '/'),
        requests,
        tokens,
        cost,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens
      })
    })

    totalCost = Number(totalCost.toFixed(6))

    return {
      history,
      summary: {
        days: HISTORY_DAYS,
        activeDays,
        totalRequests,
        totalTokens,
        totalCost,
        avgDailyRequests: Number((totalRequests / HISTORY_DAYS).toFixed(2)),
        avgDailyTokens: Number((totalTokens / HISTORY_DAYS).toFixed(2)),
        avgDailyCost: Number((totalCost / HISTORY_DAYS).toFixed(6))
      },
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      generatedAt: new Date().toISOString()
    }
  }
}

module.exports = new ApiKeyMonthlyUsageService()
module.exports.ApiKeyMonthlyUsageService = ApiKeyMonthlyUsageService
module.exports.HISTORY_DAYS = HISTORY_DAYS

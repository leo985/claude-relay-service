const redis = require('../models/redis')
const apiKeyMonthlyUsageService = require('./apiKeyMonthlyUsageService')
const logger = require('../utils/logger')

const DAY_MS = 24 * 60 * 60 * 1000
const RANK_RANGES = [
  { name: 'today', days: 1 },
  { name: '7days', days: 7 },
  { name: '30days', days: 30 }
]

function toInteger(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getMembersForKey(members, keyId) {
  const prefix = `${keyId}:`
  return (members || []).filter((member) => member.startsWith(prefix))
}

class ApiKeyDailyUsageService {
  constructor(options = {}) {
    this.redis = options.redis || redis
    this.monthlyUsageService = options.monthlyUsageService || apiKeyMonthlyUsageService
    this.logger = options.logger || logger
    this.now = options.now || (() => new Date())
  }

  async reset(keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('API key ID is required')
    }

    const apiKey = await this.redis.getApiKey(keyId)
    if (!apiKey || Object.keys(apiKey).length === 0) {
      const error = new Error('API key not found')
      error.code = 'API_KEY_NOT_FOUND'
      throw error
    }

    const client = this.redis.getClientSafe()
    const now = this.now()
    const today = this.redis.getDateStringInTimezone(now)
    const hours = Array.from(
      { length: 24 },
      (_, hour) => `${today}:${String(hour).padStart(2, '0')}`
    )

    const lookup = client.pipeline()
    lookup.hgetall(`usage:daily:${keyId}:${today}`)
    lookup.get(`usage:cost:daily:${keyId}:${today}`)
    lookup.get(`usage:cost:real:daily:${keyId}:${today}`)
    lookup.smembers(`usage:keymodel:daily:index:${today}`)
    hours.forEach((hourKey) => lookup.smembers(`usage:keymodel:hourly:index:${hourKey}`))

    const lookupResults = await lookup.exec()
    const lookupError = lookupResults.find(([error]) => error)?.[0]
    if (lookupError) {
      throw lookupError
    }

    const dailyUsage = lookupResults[0]?.[1] || {}
    const ratedCost = toNumber(lookupResults[1]?.[1])
    const realCost = toNumber(lookupResults[2]?.[1])
    const dailyIndexKey = `usage:keymodel:daily:index:${today}`
    const dailyMembers = getMembersForKey(lookupResults[3]?.[1], keyId)
    const hourlyMembers = hours.map((hourKey, index) => ({
      hourKey,
      indexKey: `usage:keymodel:hourly:index:${hourKey}`,
      members: getMembersForKey(lookupResults[index + 4]?.[1], keyId)
    }))

    const keysToDelete = new Set([
      `usage:daily:${keyId}:${today}`,
      `usage:cost:daily:${keyId}:${today}`,
      `usage:cost:real:daily:${keyId}:${today}`
    ])

    dailyMembers.forEach((member) => {
      const model = member.slice(keyId.length + 1)
      keysToDelete.add(`usage:${keyId}:model:daily:${model}:${today}`)
    })

    hourlyMembers.forEach(({ hourKey, members }) => {
      keysToDelete.add(`usage:hourly:${keyId}:${hourKey}`)
      keysToDelete.add(`usage:cost:hourly:${keyId}:${hourKey}`)
      members.forEach((member) => {
        const model = member.slice(keyId.length + 1)
        keysToDelete.add(`usage:${keyId}:model:hourly:${model}:${hourKey}`)
      })
    })

    const transaction = client.multi()
    transaction.del(...keysToDelete)
    transaction.srem(`usage:daily:index:${today}`, keyId)
    if (dailyMembers.length > 0) {
      transaction.srem(dailyIndexKey, ...dailyMembers)
    }
    hourlyMembers.forEach(({ hourKey, indexKey, members }) => {
      transaction.srem(`usage:hourly:index:${hourKey}`, keyId)
      if (members.length > 0) {
        transaction.srem(indexKey, ...members)
      }
    })

    const resetResults = await transaction.exec()
    const resetError = resetResults.find(([error]) => error)?.[0]
    if (resetError) {
      throw resetError
    }

    let costRanksUpdated = true
    try {
      await this._refreshCostRanks(client, keyId, now)
    } catch (error) {
      costRanksUpdated = false
      this.logger.warn(`Failed to refresh cost ranks after resetting API key ${keyId}:`, error)
    }
    this.monthlyUsageService.invalidate(keyId, today)

    const inputTokens = toInteger(dailyUsage.inputTokens)
    const outputTokens = toInteger(dailyUsage.outputTokens)
    const cacheCreateTokens = toInteger(dailyUsage.cacheCreateTokens)
    const cacheReadTokens = toInteger(dailyUsage.cacheReadTokens)
    const componentTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
    const tokens = Object.prototype.hasOwnProperty.call(dailyUsage, 'allTokens')
      ? toInteger(dailyUsage.allTokens)
      : componentTokens || toInteger(dailyUsage.tokens)

    return {
      keyId,
      date: today,
      deletedKeys: resetResults[0]?.[1] || 0,
      resetModelStats: dailyMembers.length,
      costRanksUpdated,
      previous: {
        requests: toInteger(dailyUsage.requests),
        tokens,
        ratedCost,
        realCost
      },
      preserved: {
        historicalTotals: true,
        requestTimeline: true,
        accountAndGlobalUsage: true,
        rateLimitWindow: true
      },
      resetAt: new Date().toISOString()
    }
  }

  async _refreshCostRanks(client, keyId, now) {
    const dates = []
    for (let offset = 29; offset >= 0; offset--) {
      dates.push(this.redis.getDateStringInTimezone(new Date(now.getTime() - offset * DAY_MS)))
    }

    const pipeline = client.pipeline()
    dates.forEach((date) => pipeline.get(`usage:cost:daily:${keyId}:${date}`))
    const results = await pipeline.exec()
    const resultError = results.find(([error]) => error)?.[0]
    if (resultError) {
      throw resultError
    }

    const costs = results.map(([, value]) => toNumber(value))
    const rankUpdate = client.pipeline()
    RANK_RANGES.forEach(({ name, days }) => {
      const cost = costs.slice(-days).reduce((sum, value) => sum + value, 0)
      rankUpdate.zadd(`cost_rank:${name}`, cost, keyId)
    })
    const rankResults = await rankUpdate.exec()
    const rankError = rankResults.find(([error]) => error)?.[0]
    if (rankError) {
      throw rankError
    }
  }
}

module.exports = new ApiKeyDailyUsageService()
module.exports.ApiKeyDailyUsageService = ApiKeyDailyUsageService

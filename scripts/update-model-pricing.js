#!/usr/bin/env node

/**
 * 手动更新模型价格数据脚本
 * 从价格镜像拉取最新价格，并写入 Redis 数据库中的 pricingService 存储。
 */

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
}

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow}[WARNING]${colors.reset} ${msg}`)
}

async function main() {
  console.log(`${colors.bright}${colors.blue}======================================${colors.reset}`)
  console.log(`${colors.bright}  Model Pricing Database Update Tool${colors.reset}`)
  console.log(
    `${colors.bright}${colors.blue}======================================${colors.reset}\n`
  )

  try {
    log.info('Connecting to Redis...')
    await redis.connect()

    log.info('Fetching latest pricing data from configured price mirror...')
    const result = await pricingService.forceUpdate()
    const status = pricingService.getStatus()

    if (result.success) {
      log.success(result.message)
    } else {
      log.warn(result.message)
    }

    log.info(`Storage: Redis (${pricingService.DB_KEY})`)
    log.info(`Source: ${status.source || 'unknown'}`)
    log.info(`Models: ${status.modelCount}`)
    log.info(`Last updated: ${status.lastUpdated ? status.lastUpdated.toISOString() : 'unknown'}`)

    if (!result.success) {
      process.exitCode = 1
    }
  } catch (error) {
    log.error(`Failed to update model pricing: ${error.message}`)
    process.exitCode = 1
  } finally {
    pricingService.cleanup()
    await redis.disconnect().catch(() => {})
  }
}

main()

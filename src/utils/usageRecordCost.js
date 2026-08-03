const COST_DECIMALS = 6
const BREAKDOWN_DECIMALS = 12

function readFiniteCost(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function roundCost(value, decimals = COST_DECIMALS) {
  return Number(readFiniteCost(value).toFixed(decimals))
}

function scaleCostBreakdown(breakdown, sourceCost, targetCost) {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return undefined
  }

  const normalizedSourceCost = readFiniteCost(sourceCost)
  const normalizedTargetCost = readFiniteCost(targetCost)
  const ratio = normalizedSourceCost > 0 ? normalizedTargetCost / normalizedSourceCost : 1
  const scaled = {}

  for (const [field, value] of Object.entries(breakdown)) {
    const parsed = Number(value)
    scaled[field] = Number.isFinite(parsed) ? roundCost(parsed * ratio, BREAKDOWN_DECIMALS) : value
  }
  scaled.total = roundCost(normalizedTargetCost, BREAKDOWN_DECIMALS)
  return scaled
}

function createUsageRecordCostFields({ realCost, ratedCost, billableCost, costBreakdown }) {
  const normalizedRealCost = roundCost(realCost)
  const normalizedRatedCost = roundCost(ratedCost)
  const normalizedBillableCost = roundCost(billableCost)

  return {
    // Keep cost as the public rated amount for compatibility with existing stored records.
    cost: normalizedRatedCost,
    realCost: normalizedRealCost,
    ratedCost: normalizedRatedCost,
    billableCost: normalizedBillableCost,
    costBreakdown,
    realCostBreakdown: costBreakdown,
    ratedCostBreakdown: scaleCostBreakdown(costBreakdown, normalizedRealCost, normalizedRatedCost),
    billableCostBreakdown: scaleCostBreakdown(
      costBreakdown,
      normalizedRealCost,
      normalizedBillableCost
    )
  }
}

function resolveUsageRecordCosts(record = {}, fallbackCost = 0) {
  const fallback = readFiniteCost(fallbackCost)
  const realCost = readFiniteCost(record.realCost, fallback)
  const ratedCost = readFiniteCost(record.ratedCost, readFiniteCost(record.cost, fallback))
  const billableCost = readFiniteCost(record.billableCost, ratedCost)

  return {
    realCost,
    ratedCost,
    billableCost
  }
}

module.exports = {
  createUsageRecordCostFields,
  readFiniteCost,
  resolveUsageRecordCosts,
  scaleCostBreakdown
}

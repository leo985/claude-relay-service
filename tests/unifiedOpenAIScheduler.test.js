jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  recordUsage: jest.fn(),
  setAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn()
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })

  describe('_rankOpenAIResponsesAccount image features', () => {
    it('allows Responses requests to use Chat Completions adapters', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'chat_completions',
          supportsTools: true,
          boundModel: 'GLM-5.1',
          modelAliases: ['gpt-5.5']
        },
        'gpt-5.5',
        {
          endpointKind: 'responses'
        }
      )

      expect(result.ok).toBe(true)
      expect(result.rank).toBe(2)
    })

    it('allows Responses requests to use passthrough adapters', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'passthrough',
          boundModel: 'GLM-5.1',
          modelAliases: ['gpt-5.5']
        },
        'gpt-5.5',
        {
          endpointKind: 'responses'
        }
      )

      expect(result.ok).toBe(true)
      expect(result.rank).toBe(2)
    })

    it('requires image generation support for Images API requests', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'responses',
          supportsImageGeneration: false,
          imageBoundModel: 'gpt-image-2'
        },
        'gpt-image-2',
        {
          endpointKind: 'images',
          hasImageGeneration: true,
          imageModel: 'gpt-image-2',
          openaiResponsesOnly: true
        }
      )

      expect(result).toEqual({
        ok: false,
        reason: 'image_generation_not_supported',
        rank: 0
      })
    })

    it('uses imageBoundModel instead of text boundModel for Images API requests', () => {
      const result = unifiedOpenAIScheduler._rankOpenAIResponsesAccount(
        {
          providerEndpoint: 'responses',
          supportsImageGeneration: true,
          boundModel: 'gpt-5.5',
          imageBoundModel: 'gpt-image-2'
        },
        'gpt-image-2',
        {
          endpointKind: 'images',
          hasImageGeneration: true,
          imageModel: 'gpt-image-2',
          openaiResponsesOnly: true
        }
      )

      expect(result.ok).toBe(true)
      expect(result.rank).toBe(3)
    })
  })

  describe('_doesSessionMappingMatchRequest request features', () => {
    it('does not reuse an image sticky mapping for a text-only request', () => {
      expect(
        unifiedOpenAIScheduler._doesSessionMappingMatchRequest(
          {
            accountId: 'vision-account',
            accountType: 'openai-responses',
            modelKey: 'GLM-5.2',
            endpointKind: 'passthrough',
            openaiResponsesOnly: true,
            hasImages: true
          },
          'GLM-5.2',
          {
            endpointKind: 'passthrough',
            openaiResponsesOnly: true,
            hasImages: false
          }
        )
      ).toBe(false)
    })

    it('does not reuse a text sticky mapping for an image request', () => {
      expect(
        unifiedOpenAIScheduler._doesSessionMappingMatchRequest(
          {
            accountId: 'text-account',
            accountType: 'openai-responses',
            modelKey: 'GLM-5.2',
            endpointKind: 'passthrough',
            openaiResponsesOnly: true,
            hasImages: false
          },
          'GLM-5.2',
          {
            endpointKind: 'passthrough',
            openaiResponsesOnly: true,
            hasImages: true
          }
        )
      ).toBe(false)
    })
  })

  describe('selectAccountFromGroup image features', () => {
    it('skips token accounts without explicit image generation support', async () => {
      accountGroupService.getGroup.mockResolvedValue({
        id: 'group-1',
        name: 'Image Group',
        platform: 'openai'
      })
      accountGroupService.getGroupMembers.mockResolvedValue(['tok-no-image', 'tok-image'])
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
      openaiAccountService.isTokenExpired.mockReturnValue(false)
      openaiAccountService.recordUsage.mockResolvedValue(undefined)
      openaiAccountService.getAccount.mockImplementation(async (accountId) => {
        const accounts = {
          'tok-no-image': {
            id: 'tok-no-image',
            name: 'Token Without Images',
            isActive: 'true',
            status: 'active',
            schedulable: 'true',
            supportsImageGeneration: false
          },
          'tok-image': {
            id: 'tok-image',
            name: 'Token With Images',
            isActive: 'true',
            status: 'active',
            schedulable: 'true',
            supportsImageGeneration: true
          }
        }
        return accounts[accountId] || null
      })

      const result = await unifiedOpenAIScheduler.selectAccountFromGroup(
        'group-1',
        null,
        'gpt-image-2',
        null,
        {
          endpointKind: 'images',
          hasImageGeneration: true,
          imageOperation: 'generations',
          imageModel: 'gpt-image-2'
        }
      )

      expect(result).toEqual({ accountId: 'tok-image', accountType: 'openai' })
      expect(openaiAccountService.recordUsage).toHaveBeenCalledWith('tok-image', 0)
    })
  })
})

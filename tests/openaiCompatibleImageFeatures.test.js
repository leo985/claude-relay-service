const {
  accountSupportsRequestFeatures,
  detectEndpointKindFromPath,
  endpointSupportsKind,
  getOpenAIImageModelRank,
  getRequestFeaturesFromBody,
  getRequestFeaturesForImages
} = require('../src/utils/openaiCompatible')

describe('openaiCompatible image features', () => {
  test('detects Images API endpoints without adding providerEndpoint=images', () => {
    expect(detectEndpointKindFromPath('/v1/images/generations')).toBe('images')
    expect(detectEndpointKindFromPath('/images/edits')).toBe('images')
    expect(endpointSupportsKind('responses', 'images')).toBe(true)
    expect(endpointSupportsKind('passthrough', 'images')).toBe(true)
    expect(endpointSupportsKind('chat_completions', 'images')).toBe(false)
  })

  test('detects Responses image_generation tool as image generation capability', () => {
    const features = getRequestFeaturesFromBody(
      {
        model: 'gpt-5.5',
        input: 'draw a city',
        tools: [{ type: 'image_generation' }]
      },
      'responses'
    )

    expect(features.hasTools).toBe(true)
    expect(features.hasImageGeneration).toBe(true)
    expect(
      accountSupportsRequestFeatures(
        { providerEndpoint: 'responses', supportsTools: true, supportsImageGeneration: false },
        features
      )
    ).toEqual({ ok: false, reason: 'image_generation_not_supported' })
  })

  test('detects Anthropic image content blocks in passthrough requests', () => {
    const features = getRequestFeaturesFromBody(
      {
        model: 'GLM-5.2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this image' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'abc'
                }
              }
            ]
          }
        ]
      },
      'passthrough'
    )

    expect(features.hasImages).toBe(true)
    expect(
      accountSupportsRequestFeatures(
        { providerEndpoint: 'passthrough', supportsImages: false },
        features
      )
    ).toEqual({ ok: false, reason: 'images_not_supported' })
  })

  test('builds explicit features for Images API requests', () => {
    // generations 不再强制 responses-only：允许 token 账号（codex/responses + image_generation）
    const generations = getRequestFeaturesForImages(
      { model: 'gpt-image-2' },
      { operation: 'generations' }
    )
    expect(generations).toMatchObject({
      endpointKind: 'images',
      hasImageGeneration: true,
      imageOperation: 'generations',
      imageModel: 'gpt-image-2'
    })
    expect(generations.openaiResponsesOnly).toBeUndefined()

    // edits 仅 responses 账号支持，需显式传 responsesOnly
    const edits = getRequestFeaturesForImages(
      { model: 'gpt-image-2' },
      { operation: 'edits', responsesOnly: true }
    )
    expect(edits).toMatchObject({
      endpointKind: 'images',
      hasImageGeneration: true,
      imageOperation: 'edits',
      imageModel: 'gpt-image-2',
      openaiResponsesOnly: true
    })

    // 不传 responsesOnly 时不会强制
    const editsOpen = getRequestFeaturesForImages({ model: 'gpt-image-2' }, { operation: 'edits' })
    expect(editsOpen.openaiResponsesOnly).toBeUndefined()
  })

  test('ranks image models separately from text boundModel', () => {
    expect(
      getOpenAIImageModelRank(
        { boundModel: 'gpt-5.5', imageBoundModel: 'gpt-image-2', imageModelAliases: [] },
        'gpt-image-2'
      )
    ).toBe(3)
    expect(
      getOpenAIImageModelRank(
        { boundModel: 'gpt-5.5', imageBoundModel: '', imageModelAliases: ['draw'] },
        'draw'
      )
    ).toBe(2)
  })
})

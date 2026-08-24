export function modelSupportsVision(modelId: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const model = modelId.toLowerCase()
  return /(gpt-4o|gpt-4\.1|gpt-5|claude-(3|4|5)|gemini|pixtral|llava|vision|qwen.*vl|glm.*(?:4v|vision)|(?:^|[-_])vl(?:[-_]|$))/.test(model)
}

/**
 * Resolve one context-window value for both pre-run attachment routing and the
 * query compiler. Using different fallbacks made a Qwen attachment look too
 * large during routing (32K) even though the actual run was compiled at 128K.
 */
export function modelContextWindow(modelId: string, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit
  const id = modelId.toLowerCase()
  if (id.includes('claude')) return 200_000
  if (id.includes('gpt-4o') || id.includes('gpt-4.1') || id.includes('gpt-5')) return 128_000
  if (id.includes('gpt-4-turbo')) return 128_000
  if (id.includes('gpt-3.5') && id.includes('16k')) return 16_384
  if (id.includes('gpt-3.5')) return 16_384
  if (id.includes('deepseek')) return 64_000
  if (id.includes('qwen') || id.includes('glm') || id.includes('moonshot')) return 128_000
  return 32_000
}

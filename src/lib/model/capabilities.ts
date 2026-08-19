export function modelSupportsVision(modelId: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const model = modelId.toLowerCase()
  return /(gpt-4o|gpt-4\.1|gpt-5|claude-(3|4|5)|gemini|pixtral|llava|vision|qwen.*vl|glm.*(?:4v|vision)|(?:^|[-_])vl(?:[-_]|$))/.test(model)
}

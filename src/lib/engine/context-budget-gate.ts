/** Small, provider-independent budget gate used by tests and CI snapshots. */
export interface ContextBudgetSnapshot {
  systemTokens: number
  fixedSystemTokens?: number
  skillTokens: number
  toolsTokens: number
  historyTokens: number
  attachmentTokens: number
  currentTaskTokens: number
  skillIndexTokens?: number
  inlineAttachmentPreviewTokens?: number
}

export const CONTEXT_BUDGET_LIMITS = {
  // The total system prompt contains both the fixed prompt and the active
  // Skill.  The previous 1,500-token limit was below the sum of the existing
  // fixed (800) and eager Skill (2,000) budgets, so valid Skills such as PPTD
  // were rejected before the model or attachment tools could run.
  // Keep a small structural margin above those two independent budgets.
  systemTokens: 3_000,
  fixedSystemTokens: 800,
  eagerSkillTokens: 2_000,
  skillIndexTokens: 600,
  inlineAttachmentPreviewTokens: 0,
} as const

export function validateContextBudgetSnapshot(snapshot: ContextBudgetSnapshot): string[] {
  const failures: string[] = []
  if (snapshot.systemTokens > CONTEXT_BUDGET_LIMITS.systemTokens) {
    failures.push(`system prompt exceeds ${CONTEXT_BUDGET_LIMITS.systemTokens} tokens (${snapshot.systemTokens})`)
  }
  if (snapshot.fixedSystemTokens !== undefined && snapshot.fixedSystemTokens > CONTEXT_BUDGET_LIMITS.fixedSystemTokens) {
    failures.push(`fixed system prompt exceeds ${CONTEXT_BUDGET_LIMITS.fixedSystemTokens} tokens (${snapshot.fixedSystemTokens})`)
  }
  if (snapshot.skillTokens > CONTEXT_BUDGET_LIMITS.eagerSkillTokens) {
    failures.push(`eager Skill context exceeds ${CONTEXT_BUDGET_LIMITS.eagerSkillTokens} tokens (${snapshot.skillTokens})`)
  }
  if (snapshot.skillIndexTokens !== undefined && snapshot.skillIndexTokens > CONTEXT_BUDGET_LIMITS.skillIndexTokens) {
    failures.push(`Skill metadata index exceeds ${CONTEXT_BUDGET_LIMITS.skillIndexTokens} tokens (${snapshot.skillIndexTokens})`)
  }
  if (snapshot.inlineAttachmentPreviewTokens !== undefined
    && snapshot.inlineAttachmentPreviewTokens > CONTEXT_BUDGET_LIMITS.inlineAttachmentPreviewTokens) {
    failures.push('inline attachment requests must not include a second preview')
  }
  return failures
}

export function assertContextBudgetSnapshot(snapshot: ContextBudgetSnapshot): void {
  const failures = validateContextBudgetSnapshot(snapshot)
  if (failures.length > 0) throw new Error(`Context budget gate failed: ${failures.join('; ')}`)
}

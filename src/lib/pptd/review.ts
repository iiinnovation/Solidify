import type { PptdProject, PptdValidationResult } from './types'

export interface PptdReviewImage {
  pageIndex: number
  imageDataUrl: string
}

export interface PptdReviewLoopOptions {
  maxRounds?: number
  visionAvailable?: boolean
  validate: (project: PptdProject) => PptdValidationResult | Promise<PptdValidationResult>
  capture: (project: PptdProject, pageIndexes: number[]) => Promise<PptdReviewImage[]>
  review: (images: PptdReviewImage[], project: PptdProject) => Promise<{ approved: boolean; feedback: string }>
  repair: (project: PptdProject, feedback: string, validation: PptdValidationResult) => Promise<PptdProject>
}

export interface PptdReviewResult {
  project: PptdProject
  approved: boolean
  rounds: number
  validation: PptdValidationResult
  feedback: string[]
}

/**
 * Local orchestration primitive for M5's visual QA loop. The model adapter is
 * injected by the caller, so the PPTD engine never depends on a remote editor.
 */
export async function runPptdReviewLoop(project: PptdProject, options: PptdReviewLoopOptions): Promise<PptdReviewResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  let current = project
  let validation = await options.validate(current)
  const feedback: string[] = []

  if (options.visionAvailable === false) {
    feedback.push('模型不支持 vision，已跳过截图审阅，仅执行结构校验')
    return { project: current, approved: validation.valid, rounds: 0, validation, feedback }
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (!validation.valid) {
      const message = validation.errors.map((item) => `${item.path}: ${item.message}`).join('\n')
      feedback.push(`结构/版式校验第 ${round} 轮：${message}`)
      current = await options.repair(current, message, validation)
      validation = await options.validate(current)
      continue
    }
    const images = await options.capture(current, current.pages.map((_page, index) => index))
    const result = await options.review(images, current)
    if (result.feedback) feedback.push(`视觉审阅第 ${round} 轮：${result.feedback}`)
    if (result.approved) return { project: current, approved: true, rounds: round, validation, feedback }
    current = await options.repair(current, result.feedback, validation)
    validation = await options.validate(current)
  }

  return { project: current, approved: false, rounds: maxRounds, validation, feedback }
}

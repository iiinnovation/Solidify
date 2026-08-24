/**
 * Conservative, local pre-run Skill routing.
 *
 * A Skill changes both instructions and the available tool surface, so clear
 * deliverable requests are routed before QueryContext is built. Uncertain
 * messages remain ordinary chat: routing must never add a hidden provider
 * request before the user's actual model call.
 */

import type { SkillMetadata } from './types'
import { isSkillEnabled } from './settings'

const MAX_DESCRIPTION_CHARS = 300

export interface SkillRouteCandidate {
  name: string
  displayName?: string
  description: string
}

/** Skills a user disabled in settings never participate in routing. */
export function toRouteCandidates(skills: readonly SkillMetadata[]): SkillRouteCandidate[] {
  return skills
    .filter((skill) => isSkillEnabled(skill.name))
    .map((skill) => ({
      name: skill.name,
      ...(skill.displayName ? { displayName: skill.displayName } : {}),
      description: skill.description.slice(0, MAX_DESCRIPTION_CHARS),
    }))
}

/** Route only unmistakable deliverable requests without a provider call. */
export function routeSkillLocally(message: string, skills: readonly SkillMetadata[]): string | undefined {
  const text = message.trim()
  if (!text || /(?:不要|无需|不需要|解释|讨论|方法论|什么是|如何安排)/i.test(text)) return undefined
  const enabled = new Set(toRouteCandidates(skills).map((skill) => skill.name))
  const routes: Array<[string, RegExp]> = [
    ['pptd-deck', /(?:做|制作|生成|创建|输出).{0,16}(?:PPT|PPTX|演示文稿|幻灯片|汇报|课件|答辩)/i],
    ['drawio-diagram', /(?:画|绘制|生成|创建|输出).{0,16}(?:Draw\.?io|流程图|架构图|时序图)/i],
    ['requirement-analysis', /(?:整理|梳理|输出|编写).{0,16}(?:需求规格|需求文档|需求分析|用户故事)/i],
    ['meeting-notes', /(?:整理|输出|生成).{0,16}(?:会议纪要|会议记录|会议待办)/i],
    ['test-plan', /(?:生成|输出|编写).{0,16}(?:测试计划|测试方案|UAT)/i],
    ['solution-design', /(?:输出|生成|编写).{0,16}(?:技术方案|解决方案|架构设计|实施计划)/i],
  ]
  return routes.find(([name, pattern]) => enabled.has(name) && pattern.test(text))?.[0]
}

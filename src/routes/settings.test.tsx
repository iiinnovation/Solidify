import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SettingsPage } from './settings'
import { getFlags, resetFlagCache } from '@/lib/harness/flags'
import { useModelStore } from '@/stores/model-store'
import { useSkillStore } from '@/stores/skill-store'

describe('SettingsPage M1 feature controls', () => {
  beforeEach(() => {
    localStorage.clear()
    resetFlagCache()
    useModelStore.setState({ providers: [], activeProviderId: null })
    useSkillStore.setState({ customSkills: [] })
  })

  it('persists Agent loop, tool calling and harness through the shared flags module', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)

    const agentLoop = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Agent 循环' })
    const toolCalling = screen.getByRole<HTMLInputElement>('checkbox', { name: '工具调用' })
    const harness = screen.getByRole<HTMLInputElement>('checkbox', { name: '安全控制平面' })
    expect(agentLoop.checked).toBe(false)
    expect(toolCalling.checked).toBe(false)
    expect(harness.checked).toBe(false)

    fireEvent.click(agentLoop)
    fireEvent.click(toolCalling)
    fireEvent.click(harness)
    expect(getFlags()).toMatchObject({ agentLoop: true, toolCalling: true, harness: true })

    fireEvent.click(toolCalling)
    expect(getFlags()).toMatchObject({ agentLoop: true, toolCalling: false })
  })
})

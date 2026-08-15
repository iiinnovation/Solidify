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

  it('persists milestone feature controls through the shared flags module', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>)

    const agentLoop = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Agent 循环' })
    const toolCalling = screen.getByRole<HTMLInputElement>('checkbox', { name: '工具调用' })
    const harness = screen.getByRole<HTMLInputElement>('checkbox', { name: '安全控制平面' })
    const localWorkspace = screen.getByRole<HTMLInputElement>('checkbox', { name: '本地工作区' })
    const workbenchV2 = screen.getByRole<HTMLInputElement>('checkbox', { name: '统一工作台' })
    expect(agentLoop.checked).toBe(false)
    expect(toolCalling.checked).toBe(false)
    expect(harness.checked).toBe(false)
    expect(localWorkspace.checked).toBe(false)
    expect(workbenchV2.checked).toBe(false)

    fireEvent.click(agentLoop)
    fireEvent.click(workbenchV2)
    expect(getFlags()).toMatchObject({ workbenchV2: true, localWorkspace: false })
    expect(localWorkspace.checked).toBe(false)
    fireEvent.click(localWorkspace)
    // Enabling tool calling hands the model write_file, so it pulls the control
    // plane on with it rather than leaving writes unguarded.
    fireEvent.click(toolCalling)
    expect(getFlags()).toMatchObject({ agentLoop: true, toolCalling: true, harness: true, localWorkspace: true, workbenchV2: true })
    expect(harness.checked).toBe(true)

    // The gate can still be disabled deliberately afterwards.
    fireEvent.click(harness)
    expect(getFlags()).toMatchObject({ toolCalling: true, harness: false })

    fireEvent.click(toolCalling)
    expect(getFlags()).toMatchObject({ agentLoop: true, toolCalling: false })
  })
})

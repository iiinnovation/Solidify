import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFileDialog: vi.fn(),
  readBinaryFile: vi.fn(),
  readSkillPackage: vi.fn(),
  writeUserSkillPackage: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  isTauri: true,
  openFileDialog: mocks.openFileDialog,
  readBinaryFile: mocks.readBinaryFile,
}))

vi.mock('@/hooks/use-skill-registry', () => ({
  useSkillRegistry: () => ({
    registry: null,
    skills: [],
    allSkills: [],
    errors: [],
    loading: false,
    refresh: mocks.refresh,
  }),
}))

vi.mock('@/lib/skills/package', () => ({
  createSkillPackage: vi.fn(),
  packageFileText: (content: string | Uint8Array) => typeof content === 'string'
    ? content
    : new TextDecoder().decode(content),
  readSkillPackage: mocks.readSkillPackage,
}))

vi.mock('@/lib/skills/migration', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/skills/migration')>(),
  removeUserSkillDirectory: vi.fn(),
  writeUserSkillDocument: vi.fn(),
  writeUserSkillPackage: mocks.writeUserSkillPackage,
}))

import { SkillsPage } from './skills'

describe('SkillsPage import', () => {
  beforeEach(() => {
    mocks.openFileDialog.mockReset()
    mocks.readBinaryFile.mockReset()
    mocks.readSkillPackage.mockReset()
    mocks.writeUserSkillPackage.mockReset()
    mocks.refresh.mockReset()
  })

  it('imports a zip selected through the native Tauri file dialog', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const document = '---\nname: imported-skill\nversion: 1.0.0\ndescription: Imported\n---\n\n# Imported\n'
    mocks.openFileDialog.mockResolvedValue('/Users/test/Desktop/imported-skill.zip')
    mocks.readBinaryFile.mockResolvedValue(bytes)
    mocks.readSkillPackage.mockResolvedValue({ 'SKILL.md': document })
    render(<MemoryRouter><SkillsPage /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: '导入 Skill ZIP' }))

    await waitFor(() => expect(mocks.writeUserSkillPackage).toHaveBeenCalledWith(
      'imported-skill',
      { 'SKILL.md': document },
    ))
    expect(mocks.openFileDialog).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
    })
    expect(mocks.readBinaryFile).toHaveBeenCalledWith('/Users/test/Desktop/imported-skill.zip')
    expect(mocks.readSkillPackage).toHaveBeenCalledWith(bytes)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByText('Skill 已导入')).not.toBeNull()
  })
})

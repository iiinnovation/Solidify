import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { FolderTaskResult } from './folder-task-result'
import type { FolderTaskRecipePlan } from '@/lib/folder-tasks/types'

it('edits business values while preserving numeric types and evidence', () => {
  const onChange = vi.fn()
  render(<FolderTaskResult value={{ facts: [{ label: '金额', value: 12, evidence: '合同第 2 页' }] }} onChange={onChange} />)
  fireEvent.change(screen.getByRole('spinbutton', { name: '值' }), { target: { value: '24' } })
  expect(onChange).toHaveBeenCalledWith({ facts: [{ label: '金额', value: 24, evidence: '合同第 2 页' }] })
})

it('presents findings and evidence as readable content', () => {
  render(<FolderTaskResult value={{ summary: '需补充付款日期', findings: [{ title: '日期缺失', evidence: '付款时间另议' }] }} />)
  expect(screen.getByText('需补充付款日期')).toBeTruthy()
  expect(screen.getByText('付款时间另议')).toBeTruthy()
})

it('adds findings from confirmed rules and removes false positives', () => {
  const plan: FolderTaskRecipePlan = { kind: 'document-review', schemaVersion: 1, rules: [{ id: 'payment', title: '付款条款', description: '检查日期', severity: 'high', evidenceRequired: true }] }
  const onChange = vi.fn()
  const { rerender } = render(<FolderTaskResult recipePlan={plan} value={{ findings: [] }} onChange={onChange} />)
  fireEvent.change(screen.getByRole('combobox', { name: '新增审查发现' }), { target: { value: 'payment' } })
  const added = { findings: [{ ruleId: 'payment', title: '付款条款', description: '', severity: 'high', evidence: '' }] }
  expect(onChange).toHaveBeenLastCalledWith(added)
  rerender(<FolderTaskResult recipePlan={plan} value={added} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: '删除审查发现' }))
  expect(onChange).toHaveBeenLastCalledWith({ findings: [] })
})

it('adds missing typed fields without offering duplicates or deleting required fields', () => {
  const plan: FolderTaskRecipePlan = { kind: 'structured-extraction', schemaVersion: 1, dedupeKeys: [], fields: [
    { name: '金额', type: 'number', description: '金额', required: true, aliases: ['amount'] },
    { name: '已签署', type: 'boolean', description: '是否签署', required: false, aliases: [] },
  ] }
  const onChange = vi.fn()
  render(<FolderTaskResult recipePlan={plan} value={{ facts: [{ label: 'amount', value: 12 }] }} onChange={onChange} />)
  expect(screen.queryByRole('option', { name: '金额' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '删除提取信息' }))
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox', { name: '新增提取信息' }), { target: { value: '已签署' } })
  expect(onChange).toHaveBeenLastCalledWith({ facts: [{ label: 'amount', value: 12 }, { label: '已签署', value: false }] })
})

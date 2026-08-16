import { afterEach, describe, expect, it } from 'vitest'
import { approvalResponder, answerApproval, subscribeApprovals } from './approval-channel'
import type { ApprovalRequest } from './approval'

function request(id: string): ApprovalRequest {
  return {
    requestId: id,
    runId: 'run',
    callId: id,
    toolName: 'write_file',
    grantKey: `write_file:${id}`,
    reason: 'write',
    prompt: { title: id, detail: id, options: [{ label: 'allow', decision: 'allow' }, { label: 'deny', decision: 'deny' }] },
    signal: new AbortController().signal,
  }
}

function abortedRequest(id: string): ApprovalRequest {
  const controller = new AbortController()
  controller.abort()
  return { ...request(id), signal: controller.signal }
}

describe('approval channel batching', () => {
  afterEach(() => {
    // Ending the subscription fail-closes any request left by a failed assertion.
    localStorage.clear()
  })

  it('keeps concurrent requests visible and independently answerable', async () => {
    const seen: string[][] = []
    const unsubscribe = subscribeApprovals((requests) => {
      seen.push(requests.map((item) => item.requestId))
      if (requests.length === 2) {
        answerApproval('a', 'allow')
        answerApproval('b', 'deny')
      }
    })
    try {
      const first = approvalResponder(request('a'))
      const second = approvalResponder(request('b'))
      await expect(Promise.all([first, second])).resolves.toEqual(['allow', 'deny'])
      expect(seen).toContainEqual(['a', 'b'])
    } finally {
      unsubscribe()
    }
  })

  it('immediately denies a request whose signal was already aborted', async () => {
    const seen: string[][] = []
    const unsubscribe = subscribeApprovals((requests) => {
      seen.push(requests.map((item) => item.requestId))
    })
    try {
      await expect(approvalResponder(abortedRequest('stopped'))).resolves.toBe('deny')
      expect(seen).toEqual([[]])
    } finally {
      unsubscribe()
    }
  })
})

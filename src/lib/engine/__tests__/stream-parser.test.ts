/**
 * Stream Parser Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createStreamParser,
  getCompletedToolCalls,
  parseToolArguments,
  type StreamParser,
} from '../stream-parser'

describe('StreamParser', () => {
  describe('OpenAI Format', () => {
    let parser: StreamParser

    beforeEach(() => {
      parser = createStreamParser('openai')
    })

    it('should parse text deltas', () => {
      const chunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'text_delta',
        text: 'Hello',
      })
    })

    it('should parse tool call start with name and id', () => {
      const chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_weather"}}]}}]}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_start',
        toolCallId: 'call_123',
        toolName: 'get_weather',
        toolIndex: 0,
      })
    })

    it('should accumulate tool call arguments across multiple chunks', () => {
      // First chunk: start with name
      let chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"get_weather","arguments":""}}]}}]}\n'
      let events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('tool_call_start')

      // Second chunk: first part of arguments
      chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]}}]}\n'
      events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_delta',
        toolCallId: 'call_123',
        toolName: 'get_weather',
        toolIndex: 0,
        argumentsDelta: '{"loc',
      })

      // Third chunk: rest of arguments
      chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"SF\\"}"}}]}}]}\n'
      events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_delta',
        toolCallId: 'call_123',
        toolName: 'get_weather',
        toolIndex: 0,
        argumentsDelta: 'ation":"SF"}',
      })

      // Verify accumulated state
      const calls = getCompletedToolCalls(parser)
      expect(calls).toHaveLength(1)
      expect(calls[0].arguments).toBe('{"location":"SF"}')
    })

    it('should handle multiple parallel tool calls', () => {
      // Start first tool
      let chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"tool_a","arguments":""}}]}}]}\n'
      parser.parse(chunk)

      // Start second tool
      chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"tool_b","arguments":""}}]}}]}\n'
      parser.parse(chunk)

      // Add args to first tool
      chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}\n'
      parser.parse(chunk)

      // Add args to second tool
      chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]}}]}\n'
      parser.parse(chunk)

      const calls = getCompletedToolCalls(parser)
      expect(calls).toHaveLength(2)
      expect(calls[0].name).toBe('tool_a')
      expect(calls[0].arguments).toBe('{"a":1}')
      expect(calls[1].name).toBe('tool_b')
      expect(calls[1].arguments).toBe('{"b":2}')
    })

    it('should emit tool_call_end on finish_reason=tool_calls', () => {
      // Start tool
      let chunk =
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"test","arguments":"{\\"x\\":1}"}}]}}]}\n'
      parser.parse(chunk)

      // Finish
      chunk = 'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_end',
        toolCallId: 'call_1',
        toolName: 'test',
        toolIndex: 0,
      })
    })

    it('should handle [DONE] marker', () => {
      const chunk = 'data: [DONE]\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('message_done')
    })
  })

  describe('Anthropic Format', () => {
    let parser: StreamParser

    beforeEach(() => {
      parser = createStreamParser('anthropic')
    })

    it('should parse text deltas', () => {
      const chunk =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'text_delta',
        text: 'Hello',
      })
    })

    it('should handle content_block_start for tool_use', () => {
      const chunk =
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather"}}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_start',
        toolCallId: 'toolu_123',
        toolName: 'get_weather',
        toolIndex: 0,
      })
    })

    it('should accumulate input_json_delta', () => {
      // Start block
      let chunk =
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"get_weather"}}\n'
      parser.parse(chunk)

      // First delta
      chunk =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}\n'
      let events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_delta',
        toolCallId: 'toolu_123',
        toolName: 'get_weather',
        toolIndex: 0,
        argumentsDelta: '{"loc',
      })

      // Second delta
      chunk =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ation\\":\\"NYC\\"}"}}\n'
      events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0].argumentsDelta).toBe('ation":"NYC"}')

      // Verify accumulated
      const calls = getCompletedToolCalls(parser)
      expect(calls[0].arguments).toBe('{"location":"NYC"}')
    })

    it('should handle content_block_stop', () => {
      // Start block
      let chunk =
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"test"}}\n'
      parser.parse(chunk)

      // Add some args
      chunk =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n'
      parser.parse(chunk)

      // Stop block
      chunk = 'data: {"type":"content_block_stop","index":0}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool_call_end',
        toolCallId: 'toolu_123',
        toolName: 'test',
        toolIndex: 0,
      })
    })

    it('should handle message_stop', () => {
      const chunk = 'data: {"type":"message_stop"}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('message_done')
    })

    it('should handle error events', () => {
      const chunk =
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}\n'
      const events = parser.parse(chunk)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Rate limit exceeded',
        },
      })
    })

    it('should handle multiple tool calls in sequence', () => {
      // First tool
      let chunk =
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"tool_a"}}\n'
      parser.parse(chunk)

      chunk =
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n'
      parser.parse(chunk)

      chunk = 'data: {"type":"content_block_stop","index":0}\n'
      parser.parse(chunk)

      // Second tool
      chunk =
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"tool_b"}}\n'
      parser.parse(chunk)

      chunk =
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":2}"}}\n'
      parser.parse(chunk)

      chunk = 'data: {"type":"content_block_stop","index":1}\n'
      parser.parse(chunk)

      const calls = getCompletedToolCalls(parser)
      expect(calls).toHaveLength(2)
      expect(calls[0].name).toBe('tool_a')
      expect(calls[1].name).toBe('tool_b')
    })
  })

  describe('Utility Functions', () => {
    it('should parse valid JSON arguments', () => {
      const args = parseToolArguments('{"location":"SF","units":"celsius"}')
      expect(args).toEqual({
        location: 'SF',
        units: 'celsius',
      })
    })

    it('should return empty object for invalid JSON', () => {
      const args = parseToolArguments('invalid json')
      expect(args).toEqual({})
    })

    it('should handle empty string', () => {
      const args = parseToolArguments('')
      expect(args).toEqual({})
    })
  })

  describe('Parser State Management', () => {
    it('should reset parser state', () => {
      const parser = createStreamParser('openai')

      // Add some data
      parser.parse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"test","arguments":"{\\"x\\":1}"}}]}}]}\n',
      )

      expect(getCompletedToolCalls(parser)).toHaveLength(1)

      // Reset
      parser.reset()

      expect(getCompletedToolCalls(parser)).toHaveLength(0)
      expect(parser.getState().buffer).toBe('')
    })

    it('should handle incomplete lines in buffer', () => {
      const parser = createStreamParser('openai')

      // Send incomplete line
      parser.parse('data: {"choices":[{"delta"')

      // Should have buffered but no events
      expect(parser.getState().buffer).toBe('data: {"choices":[{"delta"')

      // Complete the line
      const events = parser.parse(':{"content":"test"}}]}\n')

      expect(events).toHaveLength(1)
      expect(events[0].text).toBe('test')
    })
  })
})

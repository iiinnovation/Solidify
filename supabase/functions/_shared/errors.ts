import { corsHeaders } from './cors.ts'

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONVERSATION_EMPTY'
  | 'MODEL_NOT_AVAILABLE'
  | 'AI_PROVIDER_ERROR'
  | 'AI_RATE_LIMITED'
  | 'AI_CONTEXT_TOO_LONG'
  | 'INTERNAL_ERROR'

export function createErrorResponse(
  code: ErrorCode,
  status: number,
  message?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, message: message ?? code },
    }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  )
}

import type { ApiResponse } from '../../types/api'
import { ApiError } from '../../types/api'

export function parseApiEnvelope<T>(payload: unknown): ApiResponse<T> {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('INVALID_RESPONSE', '响应格式错误')
  }

  const obj = payload as Record<string, unknown>
  if (typeof obj.success !== 'boolean') {
    throw new ApiError('INVALID_RESPONSE', '缺少 success 字段')
  }

  const traceId = typeof obj.traceId === 'string' ? obj.traceId : ''
  const error = obj.error as ApiResponse<T>['error']

  if (!obj.success) {
    const code = error?.code || 'INTERNAL_ERROR'
    const message = error?.message || '请求失败'
    throw new ApiError(code, message, traceId)
  }

  return {
    success: true,
    data: obj.data as T,
    error: null,
    traceId
  }
}

export function ensureObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new ApiError('INVALID_RESPONSE', `${name} 不是对象`)
  }
  return value as Record<string, unknown>
}

export function ensureString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError('INVALID_RESPONSE', `${name} 不是有效字符串`)
  }
  return value
}

export function ensureBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError('INVALID_RESPONSE', `${name} 不是布尔值`)
  }
  return value
}

export function ensureNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ApiError('INVALID_RESPONSE', `${name} 不是有效数字`)
  }
  return value
}

export function ensureArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ApiError('INVALID_RESPONSE', `${name} 不是数组`)
  }
  return value
}

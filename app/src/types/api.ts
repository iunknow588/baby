export interface ApiResponse<T> {
  success: boolean
  data: T
  error: null | { code: string; message: string }
  traceId: string
}

export interface ApiErrorMeta {
  status?: number
  method?: string
  path?: string
}

export class ApiError extends Error {
  code: string
  traceId?: string
  meta?: ApiErrorMeta

  constructor(code: string, message: string, traceId?: string, meta?: ApiErrorMeta) {
    super(message)
    this.code = code
    this.traceId = traceId
    this.meta = meta
  }
}

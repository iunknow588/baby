export interface ApiResponse<T> {
  success: boolean
  data: T
  error: null | { code: string; message: string }
  traceId: string
}

export class ApiError extends Error {
  code: string
  traceId?: string

  constructor(code: string, message: string, traceId?: string) {
    super(message)
    this.code = code
    this.traceId = traceId
  }
}

import { ApiError } from '../../types/api'

const MESSAGE_MAP: Record<string, string> = {
  INVALID_PARAMS: '请求参数不正确，请检查输入。',
  INVALID_DEVICE_ID: '设备标识无效，请刷新页面后重试。',
  INVALID_CHAT_PAYLOAD: '聊天请求参数缺失，请重新发送。',
  INVALID_LIMIT: '分页参数无效。',
  UNAUTHORIZED: '登录已过期，请重新登录。',
  FORBIDDEN: '当前账号无权限执行该操作。',
  ROOM_NOT_FOUND: '会话不存在或已被删除。',
  MESSAGE_NOT_FOUND: '消息不存在。',
  REQUEST_IN_PROGRESS: '请求处理中，请稍后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  ASR_FAILED: '语音识别失败，请重新录音。',
  TTS_FAILED: '语音合成失败，请稍后重试。',
  INVALID_RESPONSE: '服务响应格式异常。',
  MIXED_CONTENT: 'HTTPS 页面禁止请求 HTTP 接口，请改用 HTTPS 或相对路径 /api。',
  NETWORK_ERROR: '网络异常，请检查网络连接。',
  COZE_REQUEST_FAILED: 'BOT 服务调用失败，请稍后重试。',
  USER_UPSERT_FAILED: '用户初始化失败，请稍后重试。',
  HISTORY_QUERY_FAILED: '历史记录读取失败，请稍后重试。',
  CONVERSATION_INSERT_FAILED: '消息保存失败，请稍后重试。',
  LEGACY_API_DEPRECATED: '旧版接口已下线，请升级前端版本。',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试。'
}

export function toUserError(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGE_MAP[error.code] || error.message || MESSAGE_MAP.INTERNAL_ERROR
  }
  if (error instanceof Error) {
    return error.message
  }
  return MESSAGE_MAP.INTERNAL_ERROR
}

export type MicPermissionResult = {
  granted: boolean
  reason: string
}

function mapMicError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '麦克风权限被拒绝，请在浏览器站点设置中允许麦克风。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '未检测到可用麦克风设备。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其他应用占用，请关闭后重试。'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return '当前设备不支持所需录音参数。'
  }
  if (name === 'SecurityError') {
    return '浏览器安全策略阻止了麦克风访问，请检查站点权限与隐私设置。'
  }
  return '无法访问麦克风，请检查浏览器权限设置。'
}

export async function requestMicPermission(): Promise<MicPermissionResult> {
  if (typeof window === 'undefined') {
    return { granted: false, reason: '当前环境不支持麦克风访问。' }
  }
  if (!window.isSecureContext) {
    return { granted: false, reason: '当前页面不是安全上下文（HTTPS），无法访问麦克风。' }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { granted: false, reason: '当前浏览器不支持麦克风接口。' }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach(track => track.stop())
    return { granted: true, reason: '' }
  } catch (error) {
    return { granted: false, reason: mapMicError(error) }
  }
}

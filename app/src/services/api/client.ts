import axios from 'axios'
import { ApiError } from '../../types/api'
import { getApiBaseUrl, getMixedContentRiskHint } from '../../platform/env'

export const apiClient = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 10000
})

apiClient.interceptors.request.use(config => {
  const token = localStorage.getItem('baby_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

apiClient.interceptors.response.use(
  response => response,
  error => {
    const mixedContentRisk = getMixedContentRiskHint()
    if (mixedContentRisk && (error?.code === 'ERR_NETWORK' || !error?.response)) {
      return Promise.reject(new ApiError('MIXED_CONTENT', mixedContentRisk))
    }
    const code = error?.response?.data?.error?.code || error?.code || 'NETWORK_ERROR'
    const message = error?.response?.data?.error?.message || error?.message || '网络请求失败'
    const traceId = error?.response?.data?.traceId
    return Promise.reject(new ApiError(code, message, traceId))
  }
)

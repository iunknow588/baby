import axios from 'axios'
import { ApiError } from '../../types/api'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
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
    const code = error?.response?.data?.error?.code || error?.code || 'NETWORK_ERROR'
    const message = error?.response?.data?.error?.message || error?.message || '网络请求失败'
    const traceId = error?.response?.data?.traceId
    return Promise.reject(new ApiError(code, message, traceId))
  }
)

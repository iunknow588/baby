import { apiClient } from './client'
import { ensureObject, ensureString, parseApiEnvelope } from './guard'

export interface MentorCard {
  cardType: 'advice' | 'task' | 'summary'
  title: string
  content: string
}

export const mentorApi = {
  async generateTask(roomId: string): Promise<MentorCard> {
    const res = await apiClient.post('/mentor/tasks/generate', { roomId })
    const body = parseApiEnvelope<unknown>(res.data)
    const data = ensureObject(body.data, 'mentor.generateTask.data')
    return {
      cardType: ensureString(data.cardType, 'mentor.generateTask.data.cardType') as MentorCard['cardType'],
      title: ensureString(data.title, 'mentor.generateTask.data.title'),
      content: ensureString(data.content, 'mentor.generateTask.data.content')
    }
  }
}

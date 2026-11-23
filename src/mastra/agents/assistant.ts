import { Agent } from '@mastra/core/agent'

export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'You are a helpful assistant. Keep answers concise.',
  model: 'openai/gpt-5.4-mini',
})

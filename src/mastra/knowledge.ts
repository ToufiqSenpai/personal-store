import { Knowledge, knowledgeMemoryScopes } from '@mastra/core/knowledge'

/**
 * Shared knowledge graph for the app. Storage comes from the Mastra instance
 * it is registered on (PostgreSQL, schema `mastra`).
 */
export const knowledge = new Knowledge({
  id: 'store',
  scopes: { ...knowledgeMemoryScopes() },
  tools: true,
})

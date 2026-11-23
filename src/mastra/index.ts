import { Mastra } from '@mastra/core'
import { MastraEditor } from '@mastra/editor'
import { PostgresStore } from '@mastra/pg'
import { KNOWLEDGE_ROUTES } from '@mastra/server/server-adapter'

import { assistant } from './agents/assistant.ts'
import { knowledge } from './knowledge.ts'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required for Mastra Postgres storage')
}

// Dedicated schema keeps Mastra tables separate from Payload's tables in the same database.
const storage = new PostgresStore({
  id: 'storage',
  connectionString,
  schemaName: 'mastra',
})

export const mastra = new Mastra({
  storage,
  agents: { assistant },
  knowledge: { store: knowledge },
  editor: new MastraEditor(),
  server: { apiRoutes: [...KNOWLEDGE_ROUTES] },
})

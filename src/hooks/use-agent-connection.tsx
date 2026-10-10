import { useAgent } from 'agents/react'
import { createContext, useContext } from 'react'

const AgentConnectionContext = createContext(useAgent)

/**
 * Supplies the hook the app opens Agent connections with. The app never
 * renders one, so it uses the Agents SDK's `useAgent`; tests supply a fake
 * connection in place of the SDK's WebSocket.
 */
export const AgentConnectionProvider = AgentConnectionContext.Provider

/** The hook that opens an Agent connection: `useAgent`, unless an AgentConnectionProvider supplies another. */
export function useAgentConnection(): typeof useAgent {
  return useContext(AgentConnectionContext)
}

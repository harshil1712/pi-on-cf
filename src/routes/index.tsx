import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceApp } from '../features/workspace/workspace-app'

export const Route = createFileRoute('/')({ component: WorkspaceApp })

export function Home() {
  return <WorkspaceApp />
}

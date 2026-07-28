import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceApp } from '../features/workspace/workspace-app'

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionRoute,
})

function SessionRoute() {
  const { sessionId } = Route.useParams()
  return <WorkspaceApp sessionId={sessionId} />
}

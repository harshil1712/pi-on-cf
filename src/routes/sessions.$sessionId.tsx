import { createFileRoute } from '@tanstack/react-router'
import { SessionPage } from '~/components/session-page'

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionRoute,
})

function SessionRoute() {
  const { sessionId } = Route.useParams()
  return <SessionPage sessionId={sessionId} />
}

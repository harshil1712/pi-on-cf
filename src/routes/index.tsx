import { createFileRoute } from '@tanstack/react-router'
import { SessionCatalog } from '../features/sessions/session-catalog'

export const Route = createFileRoute('/')({ component: Home })

export function Home() {
  return <SessionCatalog />
}

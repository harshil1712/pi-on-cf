import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import type { JSXElementConstructor, ReactElement, ReactNode } from 'react'

/** The app's paths. Each renders the page under test, so it can read params and navigate. */
const PATHS = ['/', '/settings', '/sessions/$sessionId']

/**
 * Render `page` under a real, in-memory router at `path`, inside `wrapper`'s
 * providers, which stay mounted across navigations. The returned router says
 * where the page navigated.
 */
export async function renderAtPath(page: ReactElement, { path = '/', wrapper }: { path?: string; wrapper?: JSXElementConstructor<{ children: ReactNode }> } = {}) {
  const rootRoute = createRootRoute({ component: Outlet })
  const routes = PATHS.map((routePath) => createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => page }))
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) })

  await act(() => router.load())

  return { ...render(<RouterProvider router={router} />, { wrapper }), router }
}

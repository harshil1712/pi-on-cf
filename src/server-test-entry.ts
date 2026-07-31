export { PiRegistry } from './server/pi-registry'
export { PiSession } from './server/pi-session'
export { ComputerTest } from './server/computer-test'
export { WorkspaceServiceProxy } from '@cloudflare/computer'

export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
}

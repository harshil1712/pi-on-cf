export { PiRegistry } from './server/pi-registry'
export { PiSession } from './server/pi-session'

export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
}

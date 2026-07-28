import { vi } from 'vitest'

class ResizeObserverStub implements ResizeObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  unobserve = vi.fn()
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

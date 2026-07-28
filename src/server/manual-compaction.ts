import { prepareCompaction, type SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { CompactionSettings } from '../shared/pi-contract'

export function prepareManualCompaction(entries: SessionTreeEntry[], settings: CompactionSettings) {
  return prepareCompaction(entries, { ...settings, keepRecentTokens: 0 })
}

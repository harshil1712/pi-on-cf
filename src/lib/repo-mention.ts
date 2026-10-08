/** The `@owner/name` being typed just before the caret, for repository suggestions. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([A-Za-z0-9_.\-/]*)$/.exec(text.slice(0, caret))
  if (!match) return null
  return { start: caret - match[1]!.length - 1, query: match[1]! }
}

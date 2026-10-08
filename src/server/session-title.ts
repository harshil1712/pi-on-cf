const MAX_TITLE_LENGTH = 60

/**
 * A session's title from its first prompt: the first line that says
 * something, short enough for one row of the catalog.
 */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.split('\n').map((value) => value.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  if (line.length <= MAX_TITLE_LENGTH) return line
  const cut = line.slice(0, MAX_TITLE_LENGTH + 1)
  const space = cut.lastIndexOf(' ')
  // A single word longer than the limit has no boundary to cut at.
  const title = space > 0 ? cut.slice(0, space) : line.slice(0, MAX_TITLE_LENGTH)
  return `${title.trimEnd()}…`
}

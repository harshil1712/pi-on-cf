/** A thrown value as text for a person: an Error's message, anything else as a string. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

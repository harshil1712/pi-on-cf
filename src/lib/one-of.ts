/** Whether `value` is one of `options`, narrowing it to their union: for the strings UI controls hand back. */
export function isOneOf<const T extends string>(options: readonly T[], value: string): value is T {
  return options.some((option) => option === value)
}

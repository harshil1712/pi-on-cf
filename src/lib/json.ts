/** A JSON value: what `JSON.parse` returns and Durable Object RPC can carry, unlike `unknown`. */
export type Json = string | number | boolean | null | Json[] | JsonObject

export type JsonObject = { [key: string]: Json }

/** Parse JSON text; undefined when it is not JSON. */
export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether a value is a JSON object rather than an array, a primitive, or nothing. */
export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string: one read from outside the type system, or one member of a union. */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

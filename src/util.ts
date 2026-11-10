/** String for any thrown value or argument, even ones String() can't convert (null-prototype objects). */
export function safeString(v: unknown): string {
  try {
    return v instanceof Error ? v.message : String(v)
  } catch {
    try {
      return JSON.stringify(v) ?? Object.prototype.toString.call(v)
    } catch {
      return Object.prototype.toString.call(v)
    }
  }
}

/** Best-effort copy for the call log; never throws. */
export function safeClone(v: unknown): unknown {
  try {
    return structuredClone(v)
  } catch {
    try {
      return JSON.parse(JSON.stringify(v)) as unknown
    } catch {
      return Object.prototype.toString.call(v)
    }
  }
}

export const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Set an own property even for keys like '__proto__' (plain assignment would change the prototype). */
export function setOwn<T>(o: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
}

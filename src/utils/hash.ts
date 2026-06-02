/**
 * FNV-1a 32-bit hash (unsigned).
 *
 * Folds each char code into the accumulator with XOR then multiplies by the
 * FNV prime. Better avalanche / lower collision risk than the previous
 * DJB2/Java-hashCode variant for change-detection over compact projections.
 */
export function hashString(str: string): number {
  let h = 2166136261; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime (32-bit)
  }
  return h >>> 0;
}

/** Alias for {@link hashString}, named for clarity at call sites. */
export const fnv1a32 = hashString;

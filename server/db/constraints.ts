/**
 * Reading a constraint name out of a database error.
 *
 * Realm-neutral on purpose. Admin and the shared badge reservation primitive
 * both need it, and neither should have to import the other's error module to
 * translate a violation — that is how one realm ends up depending on
 * another's HTTP concerns.
 *
 * THE ERROR ARRIVES WRAPPED. Drizzle catches whatever the driver threw and
 * rethrows a `DrizzleQueryError` whose message is `Failed query: …` and whose
 * `cause` is the real Postgres error. So the constraint name is NOT on the
 * object handed to this function, and its message does not mention it either:
 *
 *   DrizzleQueryError            message: "Failed query: insert into …"
 *     └─ cause: NeonDbError      constraint: "badge_assignments_…", code: "23P01"
 *          └─ sourceError: …
 *
 * Looking only at the top level is what made every real constraint violation
 * read as an unexpected failure — an overlapping badge range reached the
 * operator as "The server returned an unexpected response." The chain is
 * therefore walked, not just the first link.
 *
 * Only KNOWN names are matched. A `null` result means "not a constraint this
 * application understands", and the caller must treat it as an unexpected
 * failure and rethrow rather than report a plausible-looking conflict.
 */

/** Enough for `DrizzleQueryError → NeonDbError → sourceError`, with slack. */
const MAX_CAUSE_DEPTH = 6

interface ErrorLink {
  constraint?: unknown
  message?: unknown
  cause?: unknown
  sourceError?: unknown
}

export const readConstraintName = (
  error: unknown,
  known: readonly string[],
): string | null => {
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      return null
    }

    seen.add(current)

    const link = current as ErrorLink

    // The driver reports it as a field wherever it can, which is exact.
    if (typeof link.constraint === 'string' && link.constraint !== '') {
      return link.constraint
    }

    /**
     * The message is the fallback, matched ONLY against names the caller
     * supplied. A wrapper's own message legitimately mentions nothing, so a
     * miss here continues down the chain rather than giving up.
     */
    if (typeof link.message === 'string') {
      const named = known.find((name) => (link.message as string).includes(name))

      if (named !== undefined) {
        return named
      }
    }

    current = link.cause ?? link.sourceError
  }

  return null
}

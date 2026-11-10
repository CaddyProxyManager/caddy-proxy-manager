/** What a caught value says: an Error's message, else `fallback`, which defaults to the value itself. */
export function thrownMessage(error: unknown, fallback = String(error)): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

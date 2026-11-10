/** What a caught value says: an Error's message, else the value itself. */
export function thrownMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

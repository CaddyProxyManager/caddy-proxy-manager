/** Its own module so a test can replace it rather than end the test runner. */

/** Long enough for the response to reach the browser, short enough not to look stuck. */
const EXIT_DELAY_MS = 750;

export function scheduleProcessRestart(reason: string): void {
  // An exit inside the handler closes the socket before the reply, which looks like a crash.
  setTimeout(() => {
    console.log(reason);
    process.exit(0);
  }, EXIT_DELAY_MS);
}

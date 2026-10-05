/**
 * Stands in for the controller's `src/lib/browser/navigation` inside the demos (see the alias in
 * astro.config.mjs). A full page load inside the setup demo loads the simulated page instead of
 * taking the reader off the documentation.
 */
import { currentSimulation } from "../setup-simulation";

export function loadPage(url: string): void {
  const simulation = currentSimulation();
  if (simulation) simulation.navigate(url);
  else window.location.assign(url);
}

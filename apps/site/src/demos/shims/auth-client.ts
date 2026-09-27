/**
 * The docs site has no `/api/auth/*`, so this never makes a request: every attempt fails as a wrong
 * password does, except in the setup demo, which has accounts of its own.
 */
import { currentSimulation } from "../setup-simulation";

const pause = () => new Promise((resolve) => setTimeout(resolve, 700));

export const authClient = {
  signIn: {
    async username(input: { username: string; password: string }) {
      const simulation = currentSimulation();
      if (simulation) return simulation.signInUsername(input.username, input.password);
      await pause();
      // No message, so the form uses its own wording.
      return { error: { status: 401 } };
    },
    async social(input: { provider: string; callbackURL?: string; errorCallbackURL?: string }) {
      const simulation = currentSimulation();
      if (simulation) return simulation.signInSocial(input.callbackURL);
      await pause();
      throw new Error("There is no identity provider behind the documentation site");
    },
  },
};

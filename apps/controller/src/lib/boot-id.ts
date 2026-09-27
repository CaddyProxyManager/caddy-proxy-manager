import { randomUUID } from "node:crypto";

/** New each process start, so a restart can be told apart from an answer by the same process. */
export const BOOT_ID = randomUUID();

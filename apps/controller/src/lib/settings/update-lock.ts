type SettingsUpdateLockState = {
  waiters: Array<() => void>;
  locked: boolean;
};

const lockGlobal = globalThis as typeof globalThis & {
  __cpmSettingsUpdateLock?: SettingsUpdateLockState;
};
lockGlobal.__cpmSettingsUpdateLock ??= { waiters: [], locked: false };
const state = lockGlobal.__cpmSettingsUpdateLock;

/** Config is built from all settings: a failed save's rollback must not undo a concurrent one. */
export async function withSettingsUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
  if (state.locked) {
    await new Promise<void>((resolve) => state.waiters.push(resolve));
  } else {
    state.locked = true;
  }

  try {
    return await operation();
  } finally {
    const next = state.waiters.shift();
    if (next) next();
    else state.locked = false;
  }
}

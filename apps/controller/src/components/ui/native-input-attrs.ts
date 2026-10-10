/**
 * Native <input> attributes Astryx forwards but does not type, so they need a cast. Dropping them
 * changes behaviour: `autoComplete` (password managers), `minLength` (sometimes the only
 * enforcement), `required` - `isRequired` only sets `aria-required`.
 */
type NativeAttrs = Record<string, string | number | boolean>;

const autofill = (value: string): NativeAttrs => ({ autoComplete: value });

export const AUTOFILL_USERNAME = autofill("username");
/** Also offers saved passkeys in the field's autofill (WebAuthn conditional UI). */
export const AUTOFILL_USERNAME_WEBAUTHN = autofill("username webauthn");
export const AUTOFILL_CURRENT_PASSWORD = autofill("current-password");
export const AUTOFILL_NEW_PASSWORD = autofill("new-password");
export const AUTOFILL_ONE_TIME_CODE = autofill("one-time-code");
export const AUTOFILL_EMAIL = autofill("email");
export const AUTOFILL_NAME = autofill("name");
export const AUTOFILL_OFF = autofill("off");

/** Restores the browser's empty-field gate. Pair with `isRequired` for the visible indicator. */
export const NATIVE_REQUIRED: NativeAttrs = { required: true };

/** For addresses, identifiers and codes, whose "corrections" would break the value. */
export const NO_SPELLCHECK: NativeAttrs = {
  spellCheck: false,
  autoCapitalize: "off",
  autoCorrect: "off",
};

/** Native constraint-validation attributes, e.g. `nativeAttrs({ minLength: 8 })`. */
export function nativeAttrs(attrs: {
  minLength?: number;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  pattern?: string;
  step?: number | string;
}): NativeAttrs {
  return attrs as NativeAttrs;
}

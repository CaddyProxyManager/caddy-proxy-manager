import { useState } from "react";
import { GeneratedPasswordField } from "@cpm/controller/src/components/ui/GeneratedPasswordField";
import { MIN_PASSWORD_LENGTH } from "@cpm/controller/src/lib/auth/password/policy";
import { passwordPolicyHint } from "@cpm/controller/src/lib/auth/password/policy-message";
import { DemoSurface } from "../DemoSurface";
import { t } from "../catalog";

/** Controlled, as in every form in the app; worded as the setup account and access list forms. */
export default function PasswordFieldDemo() {
  const [password, setPassword] = useState("");

  return (
    <DemoSurface>
      <GeneratedPasswordField
        label={t("common.password")}
        value={password}
        onChange={setPassword}
        description={passwordPolicyHint(t)}
        placeholder={t("accessLists.passwordPlaceholder")}
        minLength={MIN_PASSWORD_LENGTH}
        isRequired
      />
    </DemoSurface>
  );
}

import { useState } from "react";
import { GeneratedPasswordField } from "@cpm/controller/src/components/ui/GeneratedPasswordField";
import { DemoSurface } from "../DemoSurface";

/** Controlled, as in every form in the app. */
export default function PasswordFieldDemo() {
  const [password, setPassword] = useState("");

  return (
    <DemoSurface>
      <GeneratedPasswordField
        label="Password"
        value={password}
        onChange={setPassword}
        description="Generated passwords are 24 characters from a mixed alphabet."
        placeholder="Enter or generate a password"
        minLength={12}
        isRequired
      />
    </DemoSurface>
  );
}

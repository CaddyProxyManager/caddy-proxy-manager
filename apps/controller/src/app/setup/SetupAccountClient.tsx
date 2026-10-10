"use client";

/**
 * The role is not persisted: an agent has no database to record it in, and "agent" ends the flow.
 * `migratedFrom` explains "nothing can sign in yet" after a migration that left accounts behind,
 * which would otherwise read as a failed migration.
 */
import { KeyRound, Link as LinkIcon, User } from "lucide-react";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { passwordPolicyHint } from "@/src/lib/auth/password/policy-message";
import { FormCard, SaveButton, StatusAlert } from "@/src/components/ui/FormLayout";
import { SetupSteps } from "@/src/components/ui/SetupSteps";
import { AUTOFILL_NEW_PASSWORD, AUTOFILL_USERNAME } from "@/src/components/ui/native-input-attrs";
import { configureFirstOAuthProvider, createFirstAdmin } from "./actions";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";
import { SqliteSetupWarning } from "@/src/components/setup/SqliteSetupWarning";
import { usePageFrame } from "@/src/components/ui/standalone-page";

const AGENT_DOCS = "https://caddyproxy.com/features/agent/";

type Role = "controller" | "agent";
type Method = "local" | "oauth";

export default function SetupAccountClient({
  migratedFrom,
  hasMigrateStep,
  sqliteWarning = false,
}: {
  migratedFrom?: string | null;
  hasMigrateStep: boolean;
  sqliteWarning?: boolean;
}) {
  const frame = usePageFrame();
  const t = useTranslations();
  const ta = useTranslations("setup.account");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const tUsers = useTranslations("users");
  const [role, setRole] = useState<Role>("controller");
  const [method, setMethod] = useState<Method>("local");

  // Astryx text inputs are controlled; values reach the action through each field's htmlName.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [providerName, setProviderName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [adminState, submitAdmin] = useActionState(createFirstAdmin, { error: null });
  const [oauthState, submitOAuth] = useActionState(configureFirstOAuthProvider, { error: null });

  return (
    <Center role={frame.role}>
      <VStack gap={5} padding={5}>
        <SetupSteps stage="account" hasMigrateStep={hasMigrateStep} />
        {sqliteWarning && <SqliteSetupWarning />}
        <VStack gap={2}>
          <Heading level={frame.titleLevel}>{ta("heading")}</Heading>
          <Text color="secondary">{ta("subtitle")}</Text>
        </VStack>

        {migratedFrom && (
          <Banner
            status="info"
            title={ta("migratedTitle")}
            description={ta("migratedDescription", { source: migratedFrom })}
          />
        )}

        <FormCard title={ta("roleCardTitle")}>
          <VStack gap={3}>
            <SegmentedControl
              label={ta("roleLabel")}
              value={role}
              onChange={(value) => setRole(value as Role)}
              layout="fill"
            >
              <SegmentedControlItem value="controller" label={ta("roleController")} />
              <SegmentedControlItem value="agent" label={ta("roleAgent")} />
            </SegmentedControl>
            <Text size="sm" color="secondary">
              {ta("roleHelp")}
            </Text>
          </VStack>
        </FormCard>

        {role === "agent" ? (
          <Card padding={4}>
            <VStack gap={3}>
              <Banner status="info" title={ta("agentTitle")} description={ta("agentDescription")} />
              <Link href={AGENT_DOCS}>{ta("agentDocsLink")}</Link>
              <Button
                size="sm"
                variant="secondary"
                label={tCommon("back")}
                onClick={() => setRole("controller")}
              />
            </VStack>
          </Card>
        ) : (
          <>
            <FormCard title={ta("methodCardTitle")}>
              <SegmentedControl
                label={tUsers("signInMethod")}
                value={method}
                onChange={(value) => setMethod(value as Method)}
                layout="fill"
              >
                <SegmentedControlItem value="local" label={ta("methodLocal")} />
                <SegmentedControlItem value="oauth" label={ta("methodOauth")} />
              </SegmentedControl>
            </FormCard>

            {method === "local" ? (
              <form action={submitAdmin}>
                <FormCard title={ta("localCardTitle")}>
                  <VStack gap={3}>
                    {adminState.error && <StatusAlert message={adminState.error} success={false} />}
                    <TextInput
                      startIcon={User}
                      {...AUTOFILL_USERNAME}
                      label={tCommon("username")}
                      htmlName="username"
                      value={username}
                      onChange={setUsername}
                      isRequired
                      width="100%"
                    />
                    <GeneratedPasswordField
                      label={tCommon("password")}
                      htmlName="password"
                      description={passwordPolicyHint(t)}
                      value={password}
                      onChange={setPassword}
                      // Nobody can retype a generated value from memory.
                      onGenerate={(generated) => {
                        setPassword(generated);
                        setPasswordConfirmation(generated);
                      }}
                      isRequired
                    />
                    <TextInput
                      startIcon={KeyRound}
                      {...AUTOFILL_NEW_PASSWORD}
                      label={tCommon("confirmPassword")}
                      htmlName="passwordConfirmation"
                      type="password"
                      value={passwordConfirmation}
                      onChange={setPasswordConfirmation}
                      isRequired
                      width="100%"
                    />
                    <SaveButton label={tCommon("create")} />
                  </VStack>
                </FormCard>
              </form>
            ) : (
              <form action={submitOAuth}>
                <FormCard title={ta("oauthCardTitle")}>
                  <VStack gap={3}>
                    {oauthState.error && <StatusAlert message={oauthState.error} success={false} />}
                    <Banner
                      status="info"
                      title={ta("redirectUriTitle")}
                      description={ta("redirectUriDescription")}
                    />
                    <TextInput
                      label={tUsers("displayName")}
                      htmlName="providerName"
                      description={ta("displayNameHelp")}
                      value={providerName}
                      onChange={setProviderName}
                      isRequired
                      width="100%"
                    />
                    <TextInput
                      startIcon={LinkIcon}
                      label={tSettings("issuerUrl")}
                      htmlName="issuer"
                      description={ta("issuerHelp")}
                      value={issuer}
                      onChange={setIssuer}
                      isRequired
                      width="100%"
                    />
                    <TextInput
                      label={tSettings("clientId")}
                      htmlName="clientId"
                      value={clientId}
                      onChange={setClientId}
                      isRequired
                      width="100%"
                    />
                    <TextInput
                      startIcon={KeyRound}
                      label={tSettings("secretLabel")}
                      htmlName="clientSecret"
                      type="password"
                      value={clientSecret}
                      onChange={setClientSecret}
                      isRequired
                      width="100%"
                    />
                    <SaveButton />
                  </VStack>
                </FormCard>
              </form>
            )}
          </>
        )}
      </VStack>
    </Center>
  );
}

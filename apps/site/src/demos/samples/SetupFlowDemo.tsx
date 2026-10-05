import { type MouseEvent, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "use-intl";
import LoginClient from "@cpm/controller/src/components/auth/LoginClient";
import SetupAccountClient from "@cpm/controller/src/app/setup/SetupAccountClient";
import SetupMigrateClient from "@cpm/controller/src/app/setup/migrate/SetupMigrateClient";
import SetupSettingsClient from "@cpm/controller/src/app/setup/settings/SetupSettingsClient";
import SetupDoneClient from "@cpm/controller/src/app/setup/done/SetupDoneClient";
import {
  settingDescription,
  settingGroupTitle,
  settingLabel,
} from "@cpm/controller/src/lib/settings/messages";
import { DemoSurface } from "../DemoSurface";
import { DemoRoutes } from "../DemoLink";
import {
  LEGACY_CANDIDATES,
  SETTING_FIELDS,
  Simulation,
  type SimulationState,
  startSimulation,
} from "../setup-simulation";

const SETTING_GROUPS = ["application", "authentication", "email", "analytics", "geoip"] as const;

/**
 * First-run setup on the real screens, each given what its page would load. Everything server-side
 * is setup-simulation.ts, so the path through it is the app's.
 */
export default function SetupFlowDemo() {
  const [simulation] = useState(() => new Simulation(true));
  const state = useSyncExternalStore(
    simulation.subscribe,
    simulation.snapshot,
    simulation.snapshot,
  );

  useEffect(() => startSimulation(simulation), [simulation]);

  // Links are anchors the browser would follow off the docs; in here they are simulated loads.
  function followLinks(event: MouseEvent) {
    const anchor = (event.target as Element).closest("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href?.startsWith("/")) return;
    event.preventDefault();
    // The legacy backup is a download, which has nothing to serve here.
    if (!href.startsWith("/api/")) simulation.navigate(href);
  }

  const importedAccounts = state.accounts.filter((account) => account.password === null);

  return (
    <DemoSurface>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
          <Text type="code" size="sm">
            {state.origin}
            {state.path}
          </Text>
          <HStack gap={3} vAlign="center" wrap="wrap">
            <CheckboxInput
              label="A pre-3.0 database is on this host"
              value={state.hasLegacyDatabase}
              onChange={(checked) => simulation.reset(checked)}
            />
            <Button
              variant="secondary"
              size="sm"
              label="Start over"
              onClick={() => simulation.reset(state.hasLegacyDatabase)}
            />
          </HStack>
        </HStack>
        {state.path === "/login" && importedAccounts.length > 0 && (
          <Text size="sm" color="secondary">
            Imported accounts ({importedAccounts.map((account) => account.username).join(", ")})
            keep their old passwords, which this simulation cannot know - any password opens them.
          </Text>
        )}
        <Divider />
        {/* The screens centre themselves in the viewport's height; see demo.css. The attribute
            keeps Demo.astro from de-linking what followLinks serves. */}
        <div className="cpm-demo-auth" data-cpm-demo-routes="" onClickCapture={followLinks}>
          <DemoRoutes>
            <Page key={state.load} state={state} simulation={simulation} />
          </DemoRoutes>
        </div>
      </VStack>
    </DemoSurface>
  );
}

function Page({ state, simulation }: { state: SimulationState; simulation: Simulation }) {
  switch (state.path) {
    case "/setup/migrate":
      return <SetupMigrateClient candidates={LEGACY_CANDIDATES} rejected={[]} />;
    case "/setup":
      return (
        <SetupAccountClient
          migratedFrom={state.migratedFrom}
          hasMigrateStep={state.hasLegacyDatabase}
        />
      );
    case "/login":
      return (
        <LoginClient
          enabledProviders={state.providers.map((name, index) => ({
            id: `provider-${index}`,
            name,
          }))}
        />
      );
    case "/setup/settings":
      return <SettingsPage state={state} simulation={simulation} />;
    case "/setup/done":
      return (
        <SetupDoneClient
          source={state.migratedFrom ?? ""}
          cleanup={simulation.envCleanup()}
          dashboardOrigin={null}
        />
      );
    default:
      return <Finished simulation={simulation} hasLegacyDatabase={state.hasLegacyDatabase} />;
  }
}

/** What app/setup/settings/page.tsx hands its client on a fresh install reached at cpm.lan. */
function SettingsPage({ state, simulation }: { state: SimulationState; simulation: Simulation }) {
  const t = useTranslations();
  return (
    <SetupSettingsClient
      fields={SETTING_FIELDS.map((field) => ({
        key: field.key,
        env: field.env,
        group: field.group,
        label: settingLabel(t, field.key),
        description: settingDescription(t, field.key),
        kind: field.kind,
        secret: field.secret === true,
        generatable: field.generatable === true,
        gate: field.gate === true,
        value: field.value,
        source: "default",
      }))}
      groups={SETTING_GROUPS.map((group) => ({ id: group, title: settingGroupTitle(t, group) }))}
      general={{ defaultDomain: "localhost", acmeEmail: "" }}
      dashboard={{ enabled: true, domain: "cpm.lan", fromEnvironment: false }}
      domainClaims={simulation.domainClaims()}
      oauth={{
        existing: state.providers,
        fromEnvironment: false,
        prefill: {
          providerName: "",
          issuer: "",
          clientId: "",
          clientSecret: "",
          authorizationUrl: "",
          tokenUrl: "",
          userinfoUrl: "",
          scopes: "openid email profile",
          autoLink: false,
          roleMappingEnabled: false,
          groupsClaim: "groups",
          groupPrefix: "",
          adminGroup: "",
          operatorGroup: "",
          userGroup: "",
          viewerGroup: "",
          defaultRole: "user",
          syncGroups: false,
        },
      }}
      hasMigrateStep={state.hasLegacyDatabase}
    />
  );
}

/** Where the app opens its dashboard, which is past the end of setup and of this demo. */
function Finished({
  simulation,
  hasLegacyDatabase,
}: {
  simulation: Simulation;
  hasLegacyDatabase: boolean;
}) {
  return (
    <Card padding={5}>
      <VStack gap={3} align="start">
        <Heading level={2}>Setup is finished</Heading>
        <Text color="secondary">This is where the dashboard opens.</Text>
        <Button
          variant="primary"
          label="Start over"
          onClick={() => simulation.reset(hasLegacyDatabase)}
        />
      </VStack>
    </Card>
  );
}

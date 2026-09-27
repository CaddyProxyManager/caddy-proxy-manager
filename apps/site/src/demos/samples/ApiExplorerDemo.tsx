import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { CodeEditor } from "@cpm/controller/src/components/ui/CodeEditor";
import { DemoSurface } from "../DemoSurface";

type Example = { label: string; query: string; response: string };

/** Against the schema's real shape; no request leaves the page. */
const EXAMPLES: Record<string, Example> = {
  hosts: {
    label: "List proxy hosts",
    query: `{
  proxyHosts {
    id
    name
    domains
    enabled
  }
}`,
    response: `{
  "data": {
    "proxyHosts": [
      {
        "id": 1,
        "name": "app",
        "domains": ["app.example.com"],
        "enabled": true
      },
      {
        "id": 2,
        "name": "grafana",
        "domains": ["grafana.example.com"],
        "enabled": true
      },
      {
        "id": 3,
        "name": "staging",
        "domains": ["staging.example.com"],
        "enabled": false
      }
    ]
  }
}`,
  },
  config: {
    label: "Read one host's config",
    query: `{
  proxyHost(id: 1) {
    name
    upstreams
    config
  }
}`,
    response: `{
  "data": {
    "proxyHost": {
      "name": "app",
      "upstreams": ["http://app-1:8080", "http://app-2:8080"],
      "config": {
        "loadBalancer": {
          "enabled": true,
          "policy": "least_conn",
          "activeHealthCheck": { "enabled": true, "uri": "/healthz" }
        },
        "waf": { "enabled": true, "load_owasp_crs": true }
      }
    }
  }
}`,
  },
  apply: {
    label: "Apply the configuration",
    query: `mutation {
  applyCaddyConfig {
    ok
    appliedAt
    agents { name accepted }
  }
}`,
    response: `{
  "data": {
    "applyCaddyConfig": {
      "ok": true,
      "appliedAt": "2026-02-11T09:44:02.000Z",
      "agents": [
        { "name": "bundled", "accepted": true },
        { "name": "edge-fra", "accepted": true }
      ]
    }
  }
}`,
  },
};

const OPTIONS = Object.entries(EXAMPLES).map(([value, { label }]) => ({ value, label }));

export default function ApiExplorerDemo() {
  const [key, setKey] = useState("hosts");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const example = EXAMPLES[key] as Example;

  const select = (next: string) => {
    setKey(next);
    setSent(false);
  };

  // The delay shows the response answers the query, rather than always being there.
  const send = () => {
    setSending(true);
    setTimeout(() => {
      setSending(false);
      setSent(true);
    }, 400);
  };

  return (
    <DemoSurface>
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Selector
            label="Example"
            isLabelHidden
            value={key}
            onChange={select}
            options={OPTIONS}
            width={260}
          />
          <Button label="Run query" onClick={send} isDisabled={sending} />
          <Badge label="POST /api/graphql" />
        </HStack>

        <CodeEditor
          label="Query"
          language="plaintext"
          value={example.query}
          height="sm"
          isReadOnly
        />

        <Card>
          {sending ? (
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text type="body" size="sm" color="secondary">
                Running…
              </Text>
            </HStack>
          ) : sent ? (
            <VStack gap={2}>
              <HStack gap={2} vAlign="center">
                <Badge variant="success" label="200 OK" />
                <Text type="body" size="xsm" color="secondary">
                  Bearer token, admin role
                </Text>
              </HStack>
              <CodeEditor
                label="Response"
                language="json"
                value={example.response}
                height="md"
                isReadOnly
              />
            </VStack>
          ) : (
            <Text type="body" size="sm" color="secondary">
              Run the query to see what this deployment would answer.
            </Text>
          )}
        </Card>
      </VStack>
    </DemoSurface>
  );
}

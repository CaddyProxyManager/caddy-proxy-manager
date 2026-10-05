import { useState } from "react";
import { Globe, KeyRound, Trash2, Users } from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useTranslations } from "next-intl";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import { DataTable, type Column } from "@cpm/controller/src/components/ui/DataTable";
import { DemoSurface } from "../DemoSurface";

type Member = { id: number; username: string; addedAt: string };
type UsedBy = { id: number; domain: string; enabled: boolean };
type AccessList = {
  id: number;
  name: string;
  description: string;
  members: Member[];
  usedBy: UsedBy[];
};

/** One of each state the rail tells apart, including an empty list a host still uses. */
const LISTS: AccessList[] = [
  {
    id: 1,
    name: "Staging",
    description: "Everything not meant for the public yet",
    members: [
      { id: 1, username: "avery", addedAt: "04/01/2026" },
      { id: 2, username: "sam", addedAt: "04/01/2026" },
      { id: 3, username: "priya", addedAt: "22/01/2026" },
    ],
    usedBy: [
      { id: 1, domain: "staging.example.com", enabled: true },
      { id: 2, domain: "preview.example.com", enabled: true },
    ],
  },
  {
    id: 2,
    name: "Ops tools",
    description: "Grafana and the status page",
    members: [
      { id: 4, username: "avery", addedAt: "04/01/2026" },
      { id: 5, username: "oncall", addedAt: "17/02/2026" },
    ],
    usedBy: [{ id: 3, domain: "grafana.example.com", enabled: true }],
  },
  {
    id: 3,
    name: "Vendor",
    description: "A contractor, for as long as the contract lasts",
    members: [{ id: 6, username: "vendor-acme", addedAt: "02/03/2026" }],
    usedBy: [],
  },
  {
    id: 4,
    name: "Board preview",
    description: "Waiting on the accounts to be created",
    members: [],
    usedBy: [{ id: 4, domain: "board.example.com", enabled: true }],
  },
];

/** Labelled as AccessListsClient labels the same columns. */
const memberColumns = (labels: {
  username: string;
  added: string;
  remove: (username: string) => string;
}): Column<Member>[] => [
  {
    id: "username",
    label: labels.username,
    render: (r) => (
      <Text type="code" size="sm">
        {r.username}
      </Text>
    ),
  },
  {
    id: "addedAt",
    label: labels.added,
    width: 120,
    render: (r) => (
      <Text type="body" size="sm" color="secondary">
        {r.addedAt}
      </Text>
    ),
  },
  {
    id: "remove",
    label: "",
    width: 60,
    align: "right",
    render: (r) => (
      <IconButton variant="ghost" size="sm" icon={<Trash2 />} label={labels.remove(r.username)} />
    ),
  },
];

/** Passwords are bcrypt-hashed on save, so nothing here shows one. */
function AccessListDemoContent() {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const [selectedId, setSelectedId] = useState(1);
  const [tab, setTab] = useState("members");
  const selected = LISTS.find((list) => list.id === selectedId) ?? LISTS[0];
  if (!selected) return null;
  const isEmpty = selected.members.length === 0;

  return (
    <VStack gap={4}>
      <Card padding={2}>
        <List>
          {LISTS.map((list) => (
            <ListItem
              key={list.id}
              isSelected={list.id === selectedId}
              startContent={
                <Icon
                  icon={KeyRound}
                  size="sm"
                  color={list.id === selectedId ? "accent" : "secondary"}
                />
              }
              label={list.name}
              description={t("listRowDescription", {
                members: list.members.length,
                hosts: list.usedBy.length,
              })}
              endContent={
                // No members outranks unused: it changes what a host serves.
                list.members.length === 0 ? (
                  <Badge variant="error" label={t("noMembersBadge")} />
                ) : list.usedBy.length === 0 ? (
                  <Badge variant="warning" label={t("unusedBadge")} />
                ) : undefined
              }
              onClick={() => setSelectedId(list.id)}
            />
          ))}
        </List>
      </Card>
      {/* For the whole set, not the list in view. */}
      <Text type="supporting" color="secondary">
        {t("railSummary", {
          lists: LISTS.length,
          members: LISTS.reduce((sum, list) => sum + list.members.length, 0),
        })}
      </Text>

      <VStack gap={1}>
        <Text type="body" weight="semibold">
          {selected.name}
        </Text>
        <Text type="body" size="sm" color="secondary">
          {selected.description}
        </Text>
      </VStack>

      {/* Above the tabs: a host that answers nobody is the first thing to know. */}
      {isEmpty && selected.usedBy.length > 0 && (
        <Banner
          status="warning"
          title={t("noMembersBannerTitle")}
          description={t("noMembersBannerDescription", { count: selected.usedBy.length })}
        />
      )}

      <TabList value={tab} onChange={setTab} size="sm" hasDivider>
        <Tab
          value="members"
          label={tCommon("members")}
          icon={<Users />}
          endContent={<Badge label={selected.members.length} />}
        />
        <Tab
          value="usedBy"
          label={tCommon("usedBy")}
          icon={<Globe />}
          endContent={<Badge label={selected.usedBy.length} />}
        />
      </TabList>

      {tab === "members" ? (
        isEmpty ? (
          <EmptyState
            icon={<Users />}
            title={tCommon("noMembersYet")}
            description={t("membersEmptyDescription")}
          />
        ) : (
          <DataTable
            columns={memberColumns({
              username: tCommon("username"),
              added: t("columnAdded"),
              remove: (username) => t("removeNamed", { username }),
            })}
            data={selected.members}
            keyField="id"
          />
        )
      ) : selected.usedBy.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          title={t("unusedListTitle")}
          description={t("unusedListDescription")}
        />
      ) : (
        <Card padding={2}>
          <List hasDividers>
            {selected.usedBy.map((host) => (
              <ListItem
                key={host.id}
                startContent={<Icon icon={Globe} size="sm" color="secondary" />}
                label={host.domain}
                endContent={
                  <Badge
                    variant={host.enabled ? "success" : "neutral"}
                    label={host.enabled ? t("hostActive") : t("hostDisabled")}
                  />
                }
              />
            ))}
          </List>
        </Card>
      )}
    </VStack>
  );
}

/** Inside DemoSurface, which provides the message catalog useTranslations reads. */
export default function AccessListDemo() {
  return (
    <DemoSurface>
      <AccessListDemoContent />
    </DemoSurface>
  );
}

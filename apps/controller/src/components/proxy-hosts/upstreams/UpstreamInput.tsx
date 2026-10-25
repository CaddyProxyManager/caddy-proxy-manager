"use client";

import { type KeyboardEvent, useState } from "react";
import { GripVertical, MinusCircle, Network, Plus } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { withRowId, withRowIds, type WithRowId } from "@/lib/forms/row-id";
import { NO_SPELLCHECK } from "@/components/ui/native-input-attrs";
import { useTranslations } from "next-intl";

type UpstreamEntry = {
  protocol: string;
  address: string;
};

const PROTOCOL_OPTIONS = [
  { value: "http://", label: "http://" },
  { value: "https://", label: "https://" },
];

function parseUpstream(upstream: string): UpstreamEntry {
  if (upstream.startsWith("https://")) {
    return { protocol: "https://", address: upstream.slice(8) };
  }
  if (upstream.startsWith("http://")) {
    return { protocol: "http://", address: upstream.slice(7) };
  }
  return { protocol: "http://", address: upstream };
}

export function UpstreamInput({
  defaultUpstreams = [],
  name = "upstreams",
}: {
  defaultUpstreams?: string[];
  name?: string;
}) {
  const t = useTranslations("proxyHosts");
  const [entries, setEntries] = useState<WithRowId<UpstreamEntry>[]>(() =>
    withRowIds(
      defaultUpstreams.length > 0
        ? defaultUpstreams.map(parseUpstream)
        : [{ protocol: "http://", address: "" }],
    ),
  );

  const handleProtocolChange = (rowId: string, newProtocol: string) => {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.rowId === rowId ? { ...entry, protocol: newProtocol || "http://" } : entry,
      ),
    );
  };

  const handleAddressChange = (rowId: string, newAddress: string) => {
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.rowId !== rowId) return entry;
        if (newAddress.startsWith("https://")) {
          return { ...entry, protocol: "https://", address: newAddress.slice(8) };
        }
        if (newAddress.startsWith("http://")) {
          return { ...entry, protocol: "http://", address: newAddress.slice(7) };
        }
        return { ...entry, address: newAddress };
      }),
    );
  };

  const handleAdd = () =>
    setEntries((prev) => [...prev, withRowId({ protocol: "http://", address: "" })]);

  const handleRemove = (rowId: string) =>
    setEntries((prev) => (prev.length === 1 ? prev : prev.filter((e) => e.rowId !== rowId)));

  const moveTo = (rowId: string, to: number) =>
    setEntries((prev) => {
      const from = prev.findIndex((e) => e.rowId === rowId);
      if (from === -1 || to < 0 || to >= prev.length || to === from) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  // A row is draggable only while its handle is held, so text in its inputs still selects.
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const endDrag = () => {
    setArmed(null);
    setDragging(null);
  };

  // The rows are keyed, so the handle keeps focus as its row moves.
  const handleKeys = (event: KeyboardEvent, rowId: string, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    moveTo(rowId, index + (event.key === "ArrowUp" ? -1 : 1));
  };

  const serializedValue = entries
    .filter((e) => e.address.trim() !== "")
    .map((e) => `${e.protocol}${e.address.trim()}`)
    .join("\n");

  const isOnlyEntry = entries.length === 1;

  return (
    <Card>
      <VStack gap={3}>
        <input type="hidden" name={name} value={serializedValue} />
        <VStack gap={1}>
          <Text type="body" size="sm" weight="semibold">
            {t("upstreams")}
          </Text>
          <Text type="supporting" size="sm" color="secondary">
            {t("upstreamsOrderHelp")}
          </Text>
        </VStack>
        <Divider />
        {entries.map((entry, index) => (
          <HStack
            key={entry.rowId}
            gap={2}
            vAlign="end"
            draggable={armed === entry.rowId}
            className={dragging === entry.rowId ? "opacity-50" : undefined}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              // Firefox starts no drag without data.
              event.dataTransfer.setData("text/plain", entry.rowId);
              setDragging(entry.rowId);
            }}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              if (dragging !== entry.rowId) moveTo(dragging, index);
            }}
            onDrop={(event) => event.preventDefault()}
            onDragEnd={endDrag}
          >
            <IconButton
              variant="ghost"
              size="sm"
              className="cursor-grab"
              label={t("reorderUpstreamLabel", { index: index + 1 })}
              icon={<GripVertical />}
              isDisabled={isOnlyEntry}
              tooltip={t("reorderUpstream")}
              onPointerDown={() => setArmed(entry.rowId)}
              onPointerUp={() => setArmed(null)}
              onKeyDown={(event) => handleKeys(event, entry.rowId, index)}
            />
            <Selector
              label={t("protocol")}
              isLabelHidden
              width={120}
              options={PROTOCOL_OPTIONS}
              value={entry.protocol}
              onChange={(next) => handleProtocolChange(entry.rowId, next as string)}
            />
            <TextInput
              startIcon={Network}
              {...NO_SPELLCHECK}
              label={t("upstreamLabel", { index: index + 1 })}
              isLabelHidden
              value={entry.address}
              onChange={(next) => handleAddressChange(entry.rowId, next)}
              placeholder="10.0.0.5:8080"
              isRequired={index === 0}
            />
            <IconButton
              variant="ghost"
              size="sm"
              label={t("removeUpstreamLabel", { index: index + 1 })}
              icon={<MinusCircle />}
              isDisabled={isOnlyEntry}
              // Not a title on a wrapper span, which screen readers never announced.
              tooltip={isOnlyEntry ? t("atLeastOneUpstreamRequired") : t("removeUpstream")}
              onClick={() => handleRemove(entry.rowId)}
            />
          </HStack>
        ))}

        <HStack>
          <Button
            variant="ghost"
            size="sm"
            label={t("addUpstream")}
            icon={<Plus />}
            onClick={handleAdd}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

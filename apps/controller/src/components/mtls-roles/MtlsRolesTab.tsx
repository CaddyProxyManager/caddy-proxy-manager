"use client";

import { ShieldCheck, Plus, UserPlus } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import type { MtlsRole, MtlsRoleWithCertificates } from "@/lib/models/mtls-roles";
import type { IssuedClientCertificate } from "@/lib/models/issued-client-certificates";
import { useFormatter, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES } from "@/components/ui/Timestamp";

/** Per-position card tints. Decorative only, so they use the theme's non-semantic variants. */
const CARD_VARIANTS = ["orange", "cyan", "purple", "green", "red"] as const;

type Props = {
  roles: MtlsRole[];
  issuedCerts: IssuedClientCertificate[];
  search: string;
};

export function MtlsRolesTab({ roles, issuedCerts, search }: Props) {
  const t = useTranslations("mtlsRoles");
  const tCommon = useTranslations("common");
  const [createOpen, setCreateOpen] = useState(false);
  const activeCerts = issuedCerts.filter((c) => !c.revokedAt);

  const filtered = roles.filter(
    (r) =>
      !search ||
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.description?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <VStack gap={4}>
      {createOpen ? (
        <CreateRoleCard onClose={() => setCreateOpen(false)} />
      ) : (
        <Button
          variant="primary"
          width="100%"
          icon={<Plus />}
          label={tCommon("new")}
          onClick={() => setCreateOpen(true)}
        />
      )}

      {filtered.length === 0 && !createOpen && (
        <EmptyState
          headingLevel={2}
          icon={<ShieldCheck />}
          title={search ? t("noRolesMatchSearch") : t("noRolesYet")}
          description={t("pageDescription")}
        />
      )}

      {filtered.map((role, idx) => (
        <RoleCard
          key={role.id}
          role={role}
          variant={CARD_VARIANTS[idx % CARD_VARIANTS.length]}
          activeCerts={activeCerts}
        />
      ))}
    </VStack>
  );
}

/* ── Create role inline card ── */

function CreateRoleCard({ onClose }: { onClose: () => void }) {
  const t = useTranslations("mtlsRoles");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate() {
    if (!name.trim()) {
      setError(tErrors("nameRequired"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/v1/mtls-roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || tCommon("requestFailed", { status: res.status }));
        setSubmitting(false);
        return;
      }
      onClose();
      window.location.reload();
    } catch {
      setError(tCommon("networkError"));
      setSubmitting(false);
    }
  }

  return (
    <Card padding={5}>
      <VStack gap={3}>
        {error && <Banner status="error" title={t("couldNotCreateRole")} description={error} />}
        <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
          <TextInput
            label={tCommon("name")}
            size="sm"
            value={name}
            onChange={setName}
            placeholder={t("namePlaceholder")}
            hasAutoFocus
          />
          <TextInput
            label={tCommon("description")}
            isOptional
            size="sm"
            value={description}
            onChange={setDescription}
            placeholder={t("optional")}
          />
        </Grid>
        <HStack justify="end" gap={2}>
          <Button variant="ghost" size="sm" label={tCommon("cancel")} onClick={onClose} />
          <Button
            variant="primary"
            size="sm"
            label={tCommon("create")}
            onClick={handleCreate}
            isLoading={submitting}
            isDisabled={submitting}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

/* ── Single role card ── */

function RoleCard({
  role,
  variant,
  activeCerts,
}: {
  role: MtlsRole;
  variant: (typeof CARD_VARIANTS)[number];
  activeCerts: IssuedClientCertificate[];
}) {
  const t = useTranslations("mtlsRoles");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [assignedIds, setAssignedIds] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");

  const loadAssignments = useCallback(() => {
    fetch(`/api/v1/mtls-roles/${role.id}`)
      .then((r) => (r.ok ? r.json() : { certificate_ids: [] }))
      .then((data: MtlsRoleWithCertificates) => {
        setAssignedIds(new Set(data.certificateIds));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [role.id]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  async function handleToggle(certId: number) {
    const isAssigned = assignedIds.has(certId);
    setToggling(certId);
    try {
      if (isAssigned) {
        await fetch(`/api/v1/mtls-roles/${role.id}/certificates/${certId}`, { method: "DELETE" });
        setAssignedIds((prev) => {
          const next = new Set(prev);
          next.delete(certId);
          return next;
        });
      } else {
        await fetch(`/api/v1/mtls-roles/${role.id}/certificates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ certificateId: certId }),
        });
        setAssignedIds((prev) => new Set(prev).add(certId));
      }
    } catch {
      /* silent */
    }
    setToggling(null);
  }

  async function handleSave() {
    await fetch(`/api/v1/mtls-roles/${role.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
    });
    setEditing(false);
    window.location.reload();
  }

  async function handleDelete() {
    await fetch(`/api/v1/mtls-roles/${role.id}`, { method: "DELETE" });
    window.location.reload();
  }

  const certCountLabel = tCommon("certificateCount", { count: assignedIds.size });

  return (
    <Card variant={variant} padding={5}>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={3}>
          <HStack gap={3} vAlign="center">
            <Icon icon={ShieldCheck} />
            <VStack gap={0}>
              <Text type="body" size="sm" weight="semibold">
                {role.name}
              </Text>
              <Text type="body" size="xsm" color="secondary">
                {certCountLabel}
                {role.description && ` · ${role.description}`}
              </Text>
            </VStack>
          </HStack>
          <Badge label={assignedIds.size} />
        </HStack>

        {editing ? (
          <VStack gap={3}>
            <Grid columns={{ minWidth: 200, max: 2 }} gap={3}>
              <TextInput label={tCommon("name")} size="sm" value={name} onChange={setName} />
              <TextInput
                label={tCommon("description")}
                isOptional
                size="sm"
                value={description}
                onChange={setDescription}
                placeholder={t("optional")}
              />
            </Grid>
            <HStack justify="end" gap={2}>
              <Button
                variant="ghost"
                size="sm"
                label={tCommon("cancel")}
                onClick={() => setEditing(false)}
              />
              <Button variant="secondary" size="sm" label={tCommon("save")} onClick={handleSave} />
            </HStack>
          </VStack>
        ) : (
          <HStack justify="end" gap={2}>
            <Button
              variant="secondary"
              size="sm"
              label={tCommon("edit")}
              onClick={() => setEditing(true)}
            />
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("delete")}
              onClick={() => setDeleteOpen(true)}
            />
          </HStack>
        )}

        <Divider />

        <VStack gap={2}>
          <Text type="label" size="xsm" weight="semibold" color="secondary">
            {tNav("certificates")}{" "}
          </Text>

          {!loaded ? (
            <Text type="body" size="sm" color="secondary">
              {t("loading")}
            </Text>
          ) : activeCerts.length === 0 ? (
            <EmptyState icon={<UserPlus />} title={t("certificatesEmptyTitle")} isCompact />
          ) : (
            <List hasDividers>
              {activeCerts.map((cert) => (
                <CertAssignmentRow
                  key={cert.id}
                  cert={cert}
                  isAssigned={assignedIds.has(cert.id)}
                  isLoading={toggling === cert.id}
                  onToggle={() => handleToggle(cert.id)}
                />
              ))}
            </List>
          )}
        </VStack>
      </VStack>

      {/* Not window.confirm: unstyled, and not announced as a dialog to assistive tech. */}
      <AlertDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("deleteRole")}
        description={t("deleteRoleConfirm", { name: role.name })}
        actionLabel={t("deleteRole")}
        onAction={handleDelete}
      />
    </Card>
  );
}

function CertAssignmentRow({
  cert,
  isAssigned,
  isLoading,
  onToggle,
}: {
  cert: IssuedClientCertificate;
  isAssigned: boolean;
  isLoading: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("mtlsRoles");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const checkboxRef = useRef<HTMLInputElement>(null);

  return (
    <ListItem
      // The checkbox owns the row's keyboard access, so the whole row is a
      // click target without adding a second tab stop.
      interactiveRef={checkboxRef}
      startContent={
        <CheckboxInput
          ref={checkboxRef}
          label={t("assignToRole", { name: cert.commonName })}
          isLabelHidden
          value={isAssigned}
          isDisabled={isLoading}
          onChange={onToggle}
        />
      }
      label={cert.commonName}
      description={tCommon("expiresOnInline", {
        date: format.dateTime(new Date(cert.validTo), TIMESTAMP_STYLES.date),
      })}
      endContent={isAssigned ? <Badge label={t("assigned")} /> : undefined}
      isDisabled={isLoading}
    />
  );
}

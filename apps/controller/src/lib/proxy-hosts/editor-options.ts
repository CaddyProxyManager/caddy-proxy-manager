/**
 * What the host editor and the bulk bar choose from. Read when one opens rather than with the list,
 * which would otherwise pay a dozen queries per navigation for dialogs mostly never opened.
 */
import { type CertificatePickerOption, toCertificatePickerOption } from "../certificates/api";
import { type AccessList, listAccessLists } from "../models/access-lists";
import { type CaCertificate, listCaCertificates } from "../models/ca-certificates";
import { listCertificateSummaries } from "../models/certificates";
import { listCrsPlugins, toCrsPluginOption } from "../models/crs-plugins";
import { getForwardAuthAccessForHost } from "../models/forward-auth";
import { listGroups } from "../models/groups";
import {
  type IssuedClientCertificate,
  listIssuedClientCertificates,
} from "../models/issued-client-certificates";
import { type MtlsRole, listMtlsRoles } from "../models/mtls-roles";
import { listUsers } from "../models/user";
import { listWafPresets, toWafPresetOption } from "../models/waf-presets";
import {
  type AuthentikSettings,
  type ForwardAuthSettings,
  getAuthentikSettings,
  getForwardAuthSettings,
  getGeneralSettings,
  getTailscaleSettings,
} from "../settings";

/** WafPresetOptions' option shape, for presets and installed CRS plugins alike. */
type PickerOption = { id: number; name: string; description: string | null };

export type ForwardAuthUserOption = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};
export type ForwardAuthGroupOption = {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
};

export type HostEditorOptions = {
  certificates: CertificatePickerOption[];
  caCertificates: CaCertificate[];
  accessLists: AccessList[];
  authentikDefaults: AuthentikSettings | null;
  forwardAuthDefaults: ForwardAuthSettings | null;
  /** Never the key itself. */
  tailscaleDefaults: { enabled: boolean; hasAuthKey: boolean; defaultNode: string };
  /** Prefilled into a new host's domains; empty for none. */
  defaultDomain: string;
  mtlsRoles: MtlsRole[];
  issuedClientCerts: IssuedClientCertificate[];
  forwardAuthUsers: ForwardAuthUserOption[];
  forwardAuthGroups: ForwardAuthGroupOption[];
  wafPresets: PickerOption[];
  wafPlugins: PickerOption[];
};

export async function loadHostEditorOptions(): Promise<HostEditorOptions> {
  const [
    certificates,
    caCertificates,
    accessLists,
    authentikDefaults,
    forwardAuthDefaults,
    tailscale,
    general,
    // Safe to fail before the RBAC migration has run.
    mtlsRoles,
    issuedClientCerts,
    users,
    groups,
    wafPresets,
    crsPlugins,
  ] = await Promise.all([
    listCertificateSummaries(),
    listCaCertificates(),
    listAccessLists(),
    getAuthentikSettings(),
    getForwardAuthSettings(),
    getTailscaleSettings(),
    getGeneralSettings(),
    listMtlsRoles().catch(() => []),
    listIssuedClientCertificates().catch(() => []),
    listUsers().catch(() => []),
    listGroups().catch(() => []),
    listWafPresets(),
    listCrsPlugins(),
  ]);
  return {
    certificates: certificates.map(toCertificatePickerOption),
    caCertificates,
    accessLists,
    authentikDefaults,
    forwardAuthDefaults,
    // Never null: unsaved settings mean off with no key, exactly when the warnings matter.
    tailscaleDefaults: {
      enabled: tailscale?.enabled ?? false,
      hasAuthKey: (tailscale?.authKey ?? "").trim().length > 0,
      defaultNode: tailscale?.defaultNode ?? "",
    },
    defaultDomain: general?.defaultDomain ?? "",
    mtlsRoles,
    issuedClientCerts,
    forwardAuthUsers: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role })),
    forwardAuthGroups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      member_count: g.members.length,
    })),
    wafPresets: wafPresets.map(toWafPresetOption),
    wafPlugins: crsPlugins.map(toCrsPluginOption),
  };
}

/** One host's CPM forward-auth grants, for its editor. */
export async function loadForwardAuthAccess(
  proxyHostId: number,
): Promise<{ userIds: number[]; groupIds: number[] }> {
  const entries = await getForwardAuthAccessForHost(proxyHostId);
  return {
    userIds: entries.flatMap((e) => (e.userId === null ? [] : [e.userId])),
    groupIds: entries.flatMap((e) => (e.groupId === null ? [] : [e.groupId])),
  };
}

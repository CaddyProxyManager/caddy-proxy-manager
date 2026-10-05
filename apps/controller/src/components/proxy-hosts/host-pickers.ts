/**
 * The certificate and access list pickers' options, shared by the host editor, the bulk bar and
 * the dashboard host form. Apart from HostDialogs, so the list page does not load the editor to
 * show its bulk bar.
 */
import type { useTranslations } from "next-intl";
import type { AccessList } from "@/lib/models/access-lists";

export const NONE_VALUE = "__none__";

export function toOptions(items: { id: number; name: string }[], noneLabel: string) {
  return [
    { value: NONE_VALUE, label: noneLabel },
    ...items.map((item) => ({ value: String(item.id), label: item.name })),
  ];
}

type ProxyHostsT = ReturnType<typeof useTranslations<"proxyHosts">>;

/** A list with neither users nor IP rules admits nobody. */
export function accessListIsEmpty(list: Pick<AccessList, "entries" | "ipRules">): boolean {
  return list.entries.length === 0 && (list.ipRules?.length ?? 0) === 0;
}

/** Names the empty ones: picking one closes the host rather than guarding it. */
export function accessListOptions(accessLists: AccessList[], t: ProxyHostsT) {
  return toOptions(
    accessLists.map((list) => ({
      id: list.id,
      name: accessListIsEmpty(list) ? t("accessListNoMembers", { name: list.name }) : list.name,
    })),
    t("none"),
  );
}

export function accessListStatus(accessLists: AccessList[], accessListId: string, t: ProxyHostsT) {
  const chosen = accessLists.find((list) => String(list.id) === accessListId);
  return chosen && accessListIsEmpty(chosen)
    ? { type: "warning" as const, message: t("accessListEmptyWarning") }
    : undefined;
}

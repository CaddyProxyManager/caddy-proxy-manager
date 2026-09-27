import {
  ArrowLeftRight,
  BarChart2,
  Cable,
  FileJson2,
  History,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  UserCog,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { DestinationId } from "@/src/lib/nav/destinations";

/** One icon per destination, shared by the desktop rail, the tab bar, the drawer and More. */
export const DESTINATION_ICONS: Record<DestinationId, LucideIcon> = {
  overview: LayoutDashboard,
  "proxy-hosts": ArrowLeftRight,
  "l4-proxy-hosts": Cable,
  agents: Server,
  analytics: BarChart2,
  "access-lists": KeyRound,
  groups: Users,
  users: UserCog,
  certificates: ShieldCheck,
  waf: ShieldOff,
  "audit-log": History,
  logs: ScrollText,
  "api-docs": FileJson2,
  settings: Settings,
  profile: UserRound,
};

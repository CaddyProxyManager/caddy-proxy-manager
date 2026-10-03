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
import type { Hue } from "@/src/components/ui/accent";
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

/** The rail's icon colours; where a destination has an Overview card, the card's hue. */
export const DESTINATION_HUES: Record<DestinationId, Hue> = {
  overview: "blue",
  "proxy-hosts": "purple",
  "l4-proxy-hosts": "pink",
  agents: "teal",
  analytics: "blue",
  "access-lists": "yellow",
  groups: "orange",
  users: "cyan",
  certificates: "green",
  waf: "red",
  "audit-log": "orange",
  logs: "gray",
  "api-docs": "teal",
  settings: "gray",
  profile: "purple",
};

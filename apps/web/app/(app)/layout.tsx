import { getDb, ORG_ID, SEED_ROLES } from "@delta/db";
import { Shell, type NavItem } from "@/components/shell";
import { has, requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NAV: { group: string; items: (NavItem & { perm: string })[] }[] = [
  { group: "Overview", items: [
    { href: "/dashboard", label: "Dashboard", icon: "Gauge", perm: "dashboard:view" },
    { href: "/alerts", label: "Alerts", icon: "Bell", perm: "alerts:view" },
    { href: "/approvals", label: "Approvals", icon: "CheckSquare", perm: "dashboard:view" },
  ] },
  { group: "Operations", items: [
    { href: "/orders", label: "Orders", icon: "ShoppingBag", perm: "orders:view" },
    { href: "/shipments", label: "Shipments", icon: "Truck", perm: "shipments:view" },
    { href: "/cod", label: "COD & Settlements", icon: "Banknote", perm: "profit:view" },
    { href: "/ads", label: "Ads", icon: "Megaphone", perm: "profit:view" },
    { href: "/expenses", label: "Expenses", icon: "Receipt", perm: "profit:view" },
    { href: "/stock", label: "Stock", icon: "Boxes", perm: "profit:view" },
  ] },
  { group: "Finance", items: [
    { href: "/periods", label: "Periods", icon: "CalendarCheck", perm: "profit:view" },
    { href: "/partners", label: "Partners & Withdrawals", icon: "HandCoins", perm: "profit:view" },
    { href: "/capital", label: "Capital & Tranches", icon: "Landmark", perm: "profit:view" },
    { href: "/journal", label: "Journal", icon: "BookOpen", perm: "profit:view" },
  ] },
  { group: "Admin", items: [
    { href: "/configuration", label: "Configuration", icon: "FileCog", perm: "profit:view" },
    { href: "/integrations", label: "Integrations", icon: "PlugZap", perm: "profit:view" },
    { href: "/users", label: "Users & Roles", icon: "Users", perm: "users:manage" },
    { href: "/audit", label: "Audit log", icon: "ScrollText", perm: "audit:view" },
    { href: "/account", label: "My account", icon: "Users", perm: "*any" },
  ] },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  const db = await getDb();
  const [alerts, approvals] = await Promise.all([
    has(u, "alerts:view") ? db.collection("alerts").countDocuments({ orgId: ORG_ID, acknowledgedAt: null }) : 0,
    db.collection("approvals").countDocuments({ orgId: ORG_ID, status: "pending", "decision.approverRoles": u.role, "decisions.userId": { $ne: u._id } }),
  ]);
  const nav = NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => i.perm === "*any" || has(u, i.perm)).map(({ perm: _p, ...i }) => ({ ...i, badge: i.href === "/alerts" ? alerts : i.href === "/approvals" ? approvals : undefined })) })).filter((g) => g.items.length);
  const roleLabel = SEED_ROLES.find((r) => r.key === u.role)?.label ?? u.role;
  return (
    <Shell nav={nav} user={{ name: u.name, roleLabel }}>
      {children}
    </Shell>
  );
}

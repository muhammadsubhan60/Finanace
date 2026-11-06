"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Banknote, Bell, BookOpen, Boxes, CalendarCheck, CheckSquare, FileCog, Gauge, HandCoins, LogOut, Megaphone, Menu, Moon, PlugZap, Receipt,
  ScrollText, ShoppingBag, Sun, Truck, Users, Wallet, X, Landmark,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavItem { href: string; label: string; icon: keyof typeof ICONS; badge?: number }
const ICONS = { Gauge, ShoppingBag, Truck, Banknote, Megaphone, Receipt, CheckSquare, Boxes, Landmark, CalendarCheck, HandCoins, FileCog, PlugZap, Users, ScrollText, Bell, BookOpen, Wallet };

export function Shell({ nav, user, children }: { nav: { group: string; items: NavItem[] }[]; user: { name: string; roleLabel: string }; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="grid size-8 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">Δ</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-sidebar-strong">Delta Finance</div>
          <div className="text-[11px] text-sidebar-foreground/70">Local ecommerce division</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {nav.map((g) => (
          <div key={g.group} className="mt-4">
            <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50">{g.group}</div>
            <ul className="grid gap-0.5">
              {g.items.map((it) => {
                const Icon = ICONS[it.icon];
                const active = path === it.href || (it.href !== "/dashboard" && path.startsWith(it.href + "/")) || path === it.href;
                return (
                  <li key={it.href}>
                    <Link
                      href={it.href}
                      aria-current={active ? "page" : undefined}
                      className={cn("flex h-9 items-center gap-2.5 rounded-md px-2 text-[13.5px] transition-colors duration-150 hover:bg-muted hover:text-sidebar-strong", active && "bg-sidebar-active font-semibold text-primary")}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.badge ? <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">{it.badge}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <div className="px-1 text-[13px] font-medium text-sidebar-strong">{user.name}</div>
        <div className="px-1 text-xs text-sidebar-foreground/70">{user.roleLabel}</div>
        <div className="mt-2 flex gap-1">
          <ThemeToggle />
          <form action="/logout" method="post" className="flex-1">
            <button className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-[13px] hover:bg-muted hover:text-sidebar-strong">
              <LogOut className="size-4" aria-hidden /> Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="no-print sticky top-0 hidden h-dvh lg:block">{sidebar}</aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]" aria-label="Close navigation" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[272px] max-w-[85vw] shadow-xl">{sidebar}</div>
        </div>
      ) : null}
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open navigation" className="grid size-10 place-items-center rounded-md hover:bg-muted">
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <span className="text-sm font-semibold">Delta Finance</span>
        </header>
        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  return (
    <button
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid size-9 place-items-center rounded-md hover:bg-muted hover:text-sidebar-strong"
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        try {
          localStorage.setItem("theme", next ? "dark" : "light");
        } catch {}
        setDark(next);
      }}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

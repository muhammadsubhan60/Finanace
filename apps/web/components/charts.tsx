"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const rs = (minor: number) => `Rs ${Math.round(minor / 100).toLocaleString("en-PK")}`;
const compact = (minor: number) => {
  const r = minor / 100;
  return r >= 1e5 ? `${(r / 1e5).toFixed(1)}L` : r >= 1e3 ? `${(r / 1e3).toFixed(0)}k` : String(Math.round(r));
};

/** Delivered sales vs ad spend, daily. Two series distinguished by form (area vs bars), not colour alone. */
export function SalesAdsChart({ data }: { data: { date: string; sales: number; ads: number }[] }) {
  if (!data.length) return <p className="py-16 text-center text-sm text-muted-foreground">No delivered sales or ad spend in this range.</p>;
  return (
    <div className="h-64 w-full" role="img" aria-label="Daily delivered sales and ad spend">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={44} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickFormatter={compact} />
          <Tooltip
            contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--card-foreground)" }}
            formatter={(v, n) => [rs(Number(v)), n === "sales" ? "Delivered sales" : "Ad spend"]}
          />
          <Area type="monotone" dataKey="sales" stroke="var(--chart-1)" strokeWidth={2} fill="url(#gSales)" />
          <Area type="monotone" dataKey="ads" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="4 4" fill="none" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarsChart({ data, label }: { data: { name: string; value: number }[]; label: string }) {
  return (
    <div className="h-48 w-full" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
          <YAxis tickLine={false} axisLine={false} width={44} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickFormatter={compact} />
          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v) => [rs(Number(v)), label]} cursor={{ fill: "var(--muted)" }} />
          <Bar dataKey="value" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

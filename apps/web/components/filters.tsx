import { Input, Select, Button } from "./ui";

/** GET form for filters so every view is deep-linkable. */
export function FilterBar({ children, action }: { children: React.ReactNode; action?: string }) {
  return (
    <form method="get" action={action} className="no-print mb-4 flex flex-wrap items-end gap-2">
      {children}
      <Button type="submit" variant="outline" size="sm">Apply</Button>
    </form>
  );
}

export function FSelect({ name, label, value, options }: { name: string; label: string; value?: string; options: { value: string; label: string }[] }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Select name={name} defaultValue={value ?? ""} className="h-9 min-w-36 text-[13px] text-foreground">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
    </label>
  );
}

export function FInput({ name, label, value, type = "text", placeholder }: { name: string; label: string; value?: string; type?: string; placeholder?: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Input name={name} type={type} defaultValue={value} placeholder={placeholder} className="h-9 min-w-36 text-[13px] text-foreground" />
    </label>
  );
}

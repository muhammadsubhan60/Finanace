"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()}>
      <Printer aria-hidden /> Print / Save as PDF
    </Button>
  );
}

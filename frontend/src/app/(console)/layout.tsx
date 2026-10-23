"use client";

import { AppShell } from "@/components/AppShell";
import { ToastProvider } from "@/components/ui";
import { SessionProvider } from "@/lib/session";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </SessionProvider>
  );
}

import type { ReactNode } from "react";

export const head = () => ({
  title: "VibeProxy",
  description:
    "Accounts, quota, routing, and prompt-cache health in one console.",
  robots: "noindex",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

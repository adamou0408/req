import type { ReactNode } from "react";
import { Card } from "../../components";

export function DemoSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return <Card title={title}>{children}</Card>;
}

export function DemoLabel({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

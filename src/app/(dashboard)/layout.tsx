import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default function DashboardLayoutGlobal({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardLayout>{children}</DashboardLayout>;
}


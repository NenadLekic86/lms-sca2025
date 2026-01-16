import { DashboardSidebar } from "./DashboardSidebar";
import { DashboardHeader } from "./DashboardHeader";
import { DashboardFooter } from "./DashboardFooter";

export function DashboardLayout({ 
  children,
  centered = false 
}: { 
  children: React.ReactNode;
  centered?: boolean;
}) {
  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <DashboardHeader />

        <main className={`flex-1 overflow-auto ${centered ? 'flex items-center justify-center' : 'p-6'}`}>
          {children}
        </main>

        <DashboardFooter />
      </div>
    </div>
  );
}
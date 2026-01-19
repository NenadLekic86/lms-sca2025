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
    <div className="flex h-screen flex-col bg-background overflow-hidden">
      <DashboardHeader />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <DashboardSidebar />

        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <main className={`flex-1 overflow-auto ${centered ? 'flex items-center justify-center' : 'p-6'}`}>
            {children}
          </main>

          <DashboardFooter />
        </div>
      </div>
    </div>
  );
}
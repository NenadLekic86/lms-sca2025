"use client";

import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default function CompanyPage() {
  return (
    <DashboardLayout centered>
      <div className="w-full max-w-2xl space-y-4">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Company</h1>
          <p className="text-muted-foreground">
            This page is a placeholder for your company/about content.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-3 text-sm text-muted-foreground">
          <p>
            Next, we can add:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>About the platform</li>
            <li>Contact info</li>
            <li>Brand / logo / links</li>
          </ul>
        </div>
      </div>
    </DashboardLayout>
  );
}



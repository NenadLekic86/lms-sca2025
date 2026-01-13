"use client";

import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default function LegalPage() {
  return (
    <DashboardLayout centered>
      <div className="w-full max-w-3xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Legal</h1>
          <p className="text-muted-foreground">
            Terms of Service and Privacy Policy placeholders.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Terms of Service (placeholder)</h2>
            <p className="text-sm text-muted-foreground">
              Add your Terms of Service text here. We can also split this into separate pages like
              <span className="font-medium text-foreground"> /legal/terms</span> and
              <span className="font-medium text-foreground"> /legal/privacy</span>.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Privacy Policy (placeholder)</h2>
            <p className="text-sm text-muted-foreground">
              Add your Privacy Policy text here (data retention, user rights, cookies, etc.).
            </p>
          </section>
        </div>
      </div>
    </DashboardLayout>
  );
}



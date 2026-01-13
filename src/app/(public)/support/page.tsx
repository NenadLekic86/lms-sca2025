"use client";

import Link from "next/link";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";

export default function SupportPage() {
  return (
    <DashboardLayout centered>
      <div className="w-full max-w-2xl space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold text-foreground">Support</h1>
          <p className="text-muted-foreground">
            Need help accessing your account or using the LMS? We’re here to help.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Invite-only access</h2>
            <p className="text-sm text-muted-foreground">
              Accounts are created by invitation. If you don’t have an invite yet, please contact your organization admin.
            </p>
          </div>

          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Password help</h2>
            <p className="text-sm text-muted-foreground">
              If you already have an account, you can reset your password from the “Forgot password” page.
            </p>
            <div className="pt-2">
              <Button asChild variant="outline">
                <Link href="/forgot-password">Go to Forgot Password</Link>
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Contact</h2>
            <p className="text-sm text-muted-foreground">
              If you want, we can wire this page to your real support email / ticketing system next.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}



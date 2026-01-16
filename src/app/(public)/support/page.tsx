import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Simple header */}
      <header className="border-b py-4 px-6">
        <Link 
          href="/" 
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Home
        </Link>
      </header>

      {/* Static content */}
      <main className="max-w-3xl mx-auto px-6 py-12 space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-foreground">Support</h1>
          <p className="text-muted-foreground">
            Need help accessing your account or using the LMS? We&apos;re here to help.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-6">
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">Invite-Only Access</h2>
            <p className="text-muted-foreground leading-relaxed">
              Accounts are created by invitation only. If you don&apos;t have an invite yet, 
              please contact your organization administrator to request access.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">Password Help</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you already have an account but forgot your password, you can reset it 
              using the link below.
            </p>
            <div className="pt-1">
              <Button asChild variant="outline">
                <Link href="/forgot-password">Reset Password</Link>
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">Contact Support</h2>
            <p className="text-muted-foreground leading-relaxed">
              {/* Replace with your actual support contact */}
              For technical issues or questions, please email us at:{" "}
              <a href="mailto:support@example.com" className="text-primary hover:underline">
                support@example.com
              </a>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}

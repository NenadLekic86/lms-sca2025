import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function CompanyPage() {
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
          <h1 className="text-3xl font-bold text-foreground">Company</h1>
          <p className="text-muted-foreground">
            Learn more about who we are and what we do.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-6">
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">About Us</h2>
            <p className="text-muted-foreground leading-relaxed">
              {/* Replace this placeholder with your actual company description */}
              We are dedicated to providing innovative learning management solutions 
              that help organizations train and develop their teams effectively.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">Our Mission</h2>
            <p className="text-muted-foreground leading-relaxed">
              {/* Replace this placeholder with your actual mission statement */}
              To empower organizations with the tools they need to create 
              engaging learning experiences and drive continuous improvement.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              {/* Replace with your actual contact information */}
              For inquiries, please reach out to us at:{" "}
              <a href="mailto:contact@example.com" className="text-primary hover:underline">
                contact@example.com
              </a>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}

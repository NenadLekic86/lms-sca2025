import Link from "next/link";
import { Facebook, Twitter, Linkedin } from "lucide-react";

export function DashboardFooter() {
  return (
    <footer className="border-t py-4 px-6 bg-background">
      <div className="flex items-center justify-between">
        <div className="flex gap-6 text-sm text-muted-foreground">
          <Link href="/company" className="hover:text-foreground transition-colors">
            Company
          </Link>
          <Link href="/support" className="hover:text-foreground transition-colors">
            Support
          </Link>
          <Link href="/legal" className="hover:text-foreground transition-colors">
            Legal
          </Link>
        </div>

        <div className="flex gap-4">
          <Link href="#" className="text-muted-foreground hover:text-secondary transition-colors">
            <Facebook size={18} />
          </Link>
          <Link href="#" className="text-muted-foreground hover:text-secondary transition-colors">
            <Twitter size={18} />
          </Link>
          <Link href="#" className="text-muted-foreground hover:text-secondary transition-colors">
            <Linkedin size={18} />
          </Link>
        </div>
      </div>
    </footer>
  );
}
'use client';

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Mail, Lock } from "lucide-react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const notice = searchParams.get('notice');
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // If Supabase ever redirects recovery/invite users to "/" (site URL),
  // forward them to /reset-password so they can set a password.
  useEffect(() => {
    const url = new URL(window.location.href);
    const hasCode = url.searchParams.get("code");
    const hasHashTokens = window.location.hash.includes("access_token=") || window.location.hash.includes("refresh_token=");
    if (hasCode || hasHashTokens) {
      window.location.replace(`/reset-password${window.location.search}${window.location.hash}`);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    let keepLoadingUntilNavigate = false;

    // Autofill fallback: some browsers/password managers fill inputs without firing React onChange,
    // so state can be empty even when the user sees values on screen.
    const form = e.currentTarget;
    const emailFromDom =
      (form.elements.namedItem("email") as HTMLInputElement | null)?.value ?? "";
    const passwordFromDom =
      (form.elements.namedItem("password") as HTMLInputElement | null)?.value ?? "";

    const email = (emailFromDom || username).trim();
    const pwd = passwordFromDom || password;

    // Friendly validation (prevents Supabase 400 + noisy console errors)
    if (!email || !pwd) {
      setError("Please enter your email and password.");
      setIsLoading(false);
      return;
    }

    try {
      // Login with Supabase
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password: pwd,
      });

      if (authError) {
        setError("Invalid email or password.");
        setPassword("");
        return;
      }

      // Fetch user role + active flag from database.
      // IMPORTANT: do NOT use .single() here.
      // Disabled users may be hidden by RLS, which can cause PostgREST 406 (PGRST116) with .single().
      const { data: rows, error: dbError } = await supabase
        .from('users')
        .select('role, organization_id, is_active')
        .eq('id', authData.user.id)
        .limit(1);

      if (dbError) {
        throw new Error('Failed to fetch user role');
      }

      const dbUser = Array.isArray(rows) ? rows[0] : null;

      // If the row is not visible, it’s usually because the account is disabled (or not provisioned).
      if (!dbUser) {
        await supabase.auth.signOut();
        throw new Error("Your account is currently disabled. Please contact your administrator if you believe this is a mistake.");
      }

      // If RLS ever allows reading disabled users, keep this explicit check too.
      if ((dbUser as { is_active?: boolean | null }).is_active === false) {
        await supabase.auth.signOut();
        throw new Error("Your account is currently disabled. Please contact your administrator if you believe this is a mistake.");
      }

      // Check if there's a redirect URL from the query params
      const redirectTo = searchParams.get('redirect');
      
      // Determine target URL based on role
      let targetUrl = '/';
      let orgSlug: string | null = null;
      if ((dbUser.role === 'organization_admin' || dbUser.role === 'member') && dbUser.organization_id) {
        try {
          const { data: orgRow } = await supabase
            .from('organizations')
            .select('slug')
            .eq('id', dbUser.organization_id)
            .maybeSingle();
          const raw = (orgRow as { slug?: unknown } | null)?.slug;
          orgSlug = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
        } catch {
          orgSlug = null;
        }
      }
      
      if (redirectTo) {
        targetUrl = redirectTo;
      } else {
        switch (dbUser.role) {
          case 'super_admin':
            targetUrl = '/admin';
            break;
          case 'system_admin':
            targetUrl = '/system';
            break;
          case 'organization_admin':
          case 'member':
            targetUrl = dbUser.organization_id ? `/org/${orgSlug ?? dbUser.organization_id}` : '/';
            break;
          default:
            targetUrl = '/';
        }
      }

      // Navigate and refresh to update auth state
      // Keep the "Signing in..." UI active until navigation swaps screens, to avoid flashes.
      keepLoadingUntilNavigate = true;
      router.push(targetUrl);
      router.refresh();
      
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to login";
      setError(errorMessage);
      // Clear password on unexpected errors for security
      setPassword("");
    } finally {
      if (!keepLoadingUntilNavigate) {
        setIsLoading(false);
      }
    }
  };

  return (
    <div className="w-full max-w-md space-y-8">
      {/* Title */}
      <div className="text-center">
        <h1 className="text-4xl font-bold text-primary">Login</h1>
      </div>

      {notice === 'invite-only' && (
        <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-center text-foreground">
          This LMS is <span className="font-medium">invite-only</span>. Please contact your administrator to receive an invitation email.
        </div>
      )}

      {notice === 'disabled' && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-center text-foreground">
          Your account is currently <span className="font-medium">disabled</span>. Please contact your administrator if you believe this is a mistake.
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md text-sm text-center">
          {error}
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Username/Email Field */}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="Enter your email"
              autoComplete="email"
              autoCapitalize="none"
              inputMode="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              className="pl-10"
              required
              disabled={isLoading}
            />
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </div>
        </div>

        {/* Password Field */}
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="Enter your password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              className="pl-10"
              required
              disabled={isLoading}
            />
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </div>
        </div>

        {/* Submit Button */}
        <Button 
          type="submit" 
          className="w-full h-11"
          disabled={isLoading}
        >
          {isLoading ? "Signing in..." : "Sign In"}
        </Button>
      </form>

      {/* Links */}
      <div className="text-center space-y-2">
        <Link 
          href="/forgot-password" 
          className="text-sm text-primary hover:underline block"
        >
          Forgot password?
        </Link>
        <Link 
          href="/support" 
          className="text-sm text-primary hover:underline block"
        >
          Contact Support
        </Link>
      </div>
    </div>
  );
}
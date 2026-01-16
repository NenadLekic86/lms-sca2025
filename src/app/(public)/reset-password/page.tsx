"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function getHashParams() {
  const raw = typeof window !== "undefined" ? window.location.hash : "";
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const params = new URLSearchParams(hash);
  
  // New cross-browser compatible format: #token_hash=...&type=...
  const token_hash = params.get("token_hash");
  const type = params.get("type") as "recovery" | "invite" | "email" | null;
  
  // Legacy format: #access_token=...&refresh_token=...
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  
  return {
    token_hash,
    type,
    access_token,
    refresh_token,
    hasTokenHash: !!token_hash && !!type,
    hasFullTokens: !!access_token && !!refresh_token,
  };
}

export default function ResetPasswordPage() {
  const [isReady, setIsReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordsMatch = useMemo(() => password.length > 0 && password === confirmPassword, [password, confirmPassword]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setError(null);

      try {
        // Invite/recovery links can arrive in three formats:
        // 1) PKCE code in query string: ?code=... (same-browser only)
        // 2) Token hash in URL hash: #token_hash=...&type=... (cross-browser, recommended)
        // 3) Full tokens in URL hash: #access_token=...&refresh_token=... (legacy)
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const { token_hash, type, access_token, refresh_token, hasTokenHash, hasFullTokens } = getHashParams();

        if (code) {
          // PKCE code exchange - DON'T sign out before, as it can wipe the code_verifier
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            // Exchange failed - NOW sign out any existing session to prevent wrong-user password change
            try {
              await supabase.auth.signOut();
            } catch {
              // ignore
            }

            if (String(error.message || "").toLowerCase().includes("code verifier")) {
              setError(
                "This reset link cannot be used in this browser. Please open the link in the same browser where you requested it, or ask an admin to resend a new link."
              );
            } else {
              console.error("exchangeCodeForSession error:", error);
              setError(error.message || "Failed to verify reset link.");
            }
            setHasSession(false);
            return;
          }

          // Success - remove code from URL
          try {
            url.searchParams.delete("code");
            window.history.replaceState(null, "", url.pathname + url.search);
          } catch {
            // ignore
          }
        } else if (hasTokenHash) {
          // Token hash based verification (cross-browser compatible!)
          // Sign out first to clear any stale session
          try {
            await supabase.auth.signOut();
          } catch {
            // ignore
          }

          const { error } = await supabase.auth.verifyOtp({
            token_hash: token_hash!,
            type: type!,
          });

          // Clean up URL hash
          try {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
          } catch {
            // ignore
          }

          if (error) {
            console.error("verifyOtp error:", error);
            setError(error.message || "Failed to verify reset link. It may be expired.");
            setHasSession(false);
            return;
          }
        } else if (hasFullTokens) {
          // Legacy: Full JWT tokens in hash (implicit flow)
          try {
            await supabase.auth.signOut();
          } catch {
            // ignore
          }

          const { error } = await supabase.auth.setSession({
            access_token: access_token!,
            refresh_token: refresh_token!,
          });

          // Clean up URL hash
          try {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
          } catch {
            // ignore
          }

          if (error) {
            console.error("setSession error:", error);
            setError(error.message || "Failed to start reset session.");
            setHasSession(false);
            return;
          }
        }

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          console.error("getSession error:", sessionError);
          setHasSession(false);
          return;
        }
        if (cancelled) return;

        setHasSession(!!data.session);
      } catch (e) {
        console.error("Reset password init failed:", e);
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to initialize password reset.");
          setHasSession(false);
        }
      } finally {
        if (!cancelled) setIsReady(true);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!passwordsMatch) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setIsSaving(true);
    try {
      // NOTE: We intentionally bypass supabase.auth.updateUser() here.
      // In some setups it can hang after the network call (internal auth locks/storage),
      // leaving the UI stuck on "Saving..." even though the password is updated.
      // This direct REST call updates the password and then redirects reliably.
      const { data, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr || !data.session?.access_token) {
        throw new Error("No active reset session. Please request a new reset link.");
      }

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) {
        throw new Error("Missing Supabase environment variables.");
      }

      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const message =
          (typeof body.error_description === "string" && body.error_description) ||
          (typeof body.message === "string" && body.message) ||
          "Failed to update password";
        throw new Error(message);
      }

      // If this user was invited and is still pending, flip them to active now.
      // Idempotent + best-effort: for password reset of existing users this is a no-op.
      try {
        await fetch("/api/me/activate", { method: "POST" });
      } catch {
        // ignore
      }

      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update password");
      setIsSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Simple header */}
      <header className="border-b py-4 px-6">
        <Link 
          href="/" 
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Login
        </Link>
      </header>

      {/* Form content */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-bold text-foreground">Reset password</h1>
            <p className="text-muted-foreground">
              Choose a new password for your account.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="rounded-lg border bg-card p-6">
            {!isReady ? (
              <div className="text-sm text-muted-foreground">Preparing reset...</div>
            ) : !hasSession ? (
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  This reset link is invalid or expired. Please request a new one.
                </p>
                <div className="flex gap-2">
                  <Button asChild variant="outline">
                    <Link href="/forgot-password">Request new link</Link>
                  </Button>
                  <Button asChild>
                    <Link href="/">Back to login</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSaving}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isSaving}
                    required
                  />
                </div>

                <Button className="w-full" type="submit" disabled={isSaving}>
                  {isSaving ? "Saving..." : "Update password"}
                </Button>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

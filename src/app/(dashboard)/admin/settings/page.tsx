"use client";

import { Settings, Save, Upload, Globe, Palette, Bell, Shield, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useMemo, useRef, useState } from "react";
import { THEME_CACHE_KEY } from "@/lib/theme/themeConstants";

type SettingsResponse = {
  settings: {
    id: string;
    app_name: string | null;
    logo_url: string | null;
    theme: Record<string, string>;
    default_language: string | null;
    timezone: string | null;
    updated_at?: string | null;
  };
};

function applyCssVars(theme: Record<string, string>) {
  Object.entries(theme).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}

function cacheTheme(theme: Record<string, string>) {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(theme));
  } catch {
    // ignore storage issues (private mode, quota, etc.)
  }
}

export default function SystemSettingsPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isDraggingLogo, setIsDraggingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [appName, setAppName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [timezone, setTimezone] = useState("UTC");
  const [themeText, setThemeText] = useState<string>("{}");
  const [themeJsonError, setThemeJsonError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const parsedTheme = useMemo(() => {
    try {
      const parsed = JSON.parse(themeText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setThemeJsonError("Theme must be a JSON object of CSS variables.");
        return null;
      }
      const values = Object.values(parsed as Record<string, unknown>);
      if (!values.every((v) => typeof v === "string")) {
        setThemeJsonError("All theme values must be strings.");
        return null;
      }
      setThemeJsonError(null);
      return parsed as Record<string, string>;
    } catch {
      setThemeJsonError("Theme must be valid JSON.");
      return null;
    }
  }, [themeText]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to load settings");
        }
        const data = (await res.json()) as SettingsResponse;
        if (cancelled) return;

        setAppName(data.settings.app_name ?? "");
        setLogoUrl(data.settings.logo_url ?? "");
        setDefaultLanguage(data.settings.default_language ?? "en");
        setTimezone(data.settings.timezone ?? "UTC");
        setThemeText(JSON.stringify(data.settings.theme ?? {}, null, 2));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load settings");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSuccess(null);
    setError(null);

    if (themeJsonError || !parsedTheme) {
      setError("Fix theme JSON before saving.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_name: appName,
          logo_url: logoUrl,
          default_language: defaultLanguage,
          timezone,
          theme: parsedTheme,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Failed to save settings");
      }

      // Apply theme immediately (no full refresh)
      const savedTheme = (body?.settings?.theme ?? parsedTheme) as Record<string, string>;
      if (body?.settings?.theme) {
        applyCssVars(savedTheme);
        setThemeText(JSON.stringify(savedTheme ?? {}, null, 2));
      } else {
        applyCssVars(savedTheme);
      }

      // Persist theme cache for instant reloads (used by RootLayout pre-hydration script)
      cacheTheme(savedTheme);
      window.dispatchEvent(new CustomEvent("theme:updated", { detail: savedTheme }));

      // Refresh sidebar branding immediately (no hard reload)
      window.dispatchEvent(new Event("branding:updated"));

      setSuccess("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLogoSelected(file: File) {
    setError(null);
    setSuccess(null);
    setIsUploadingLogo(true);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/settings/logo", {
        method: "POST",
        body: form,
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Failed to upload logo");
      }

      if (body.logo_url) {
        setLogoUrl(body.logo_url);
      }

      // Refresh sidebar branding immediately (no hard reload)
      window.dispatchEvent(new Event("branding:updated"));

      setSuccess("Logo uploaded.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload logo");
    } finally {
      setIsUploadingLogo(false);
    }
  }

  function handleLogoDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingLogo(false);
    if (isUploadingLogo || isLoading) return;

    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please drop an image file.");
      return;
    }
    void handleLogoSelected(file);
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Settings className="h-8 w-8 text-primary shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">System Settings</h1>
            <p className="text-muted-foreground">Configure global system settings</p>
          </div>
        </div>
        <Button className="flex items-center gap-2 shrink-0" onClick={handleSave} disabled={isLoading || isSaving || !!themeJsonError}>
          <Save size={18} />
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {/* Settings Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Branding */}
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Palette className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Branding</h2>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="appName">Application Name</Label>
              <Input
                id="appName"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                className="mt-1"
                disabled={isLoading}
              />
            </div>
            <div>
              <Label htmlFor="logoUrl">Logo URL</Label>
              <div className="mt-1 flex items-center gap-4">
                <div
                  className={`relative flex min-h-20 w-full flex-1 items-center gap-4 rounded border border-dashed px-4 py-3 text-sm transition ${
                    isDraggingLogo ? "border-primary bg-primary/10" : "border-muted-foreground/30 bg-muted/40"
                  }`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!isUploadingLogo && !isLoading) setIsDraggingLogo(true);
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setIsDraggingLogo(false);
                  }}
                  onDrop={handleLogoDrop}
                  role="button"
                  tabIndex={0}
                  aria-label="Drop logo image or click to upload"
                  onClick={() => {
                    if (isUploadingLogo || isLoading) return;
                    logoInputRef.current?.click();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (isUploadingLogo || isLoading) return;
                      logoInputRef.current?.click();
                    }
                  }}
                >
                  <div className="relative h-16 w-32 bg-background rounded flex items-center justify-center text-muted-foreground text-sm overflow-hidden border">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoUrl} alt="Current logo" className="h-full w-full object-contain" />
                    ) : (
                      (appName ? appName : "No Logo")
                    )}

                    {logoUrl ? (
                      <button
                        type="button"
                        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/75"
                        title="Remove logo (clears URL)"
                        onClick={(event) => {
                          event.stopPropagation();
                          setLogoUrl("");
                          setSuccess("Logo removed (not saved). Click Save Changes to persist.");
                        }}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </div>

                  <div className="flex-1 text-muted-foreground">
                    <p className="font-medium text-foreground">Drag & drop a logo here</p>
                    <p className="text-xs">PNG, WEBP, or SVG. Click to browse.</p>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isLoading || isUploadingLogo}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      logoInputRef.current?.click();
                    }}
                  >
                    <Upload size={16} className="mr-2" />
                    {isUploadingLogo ? "Uploading..." : "Upload New"}
                  </Button>
                </div>

                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/webp,image/svg,image/svg+xml"
                  className="hidden"
                  disabled={isLoading || isUploadingLogo}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    void handleLogoSelected(f);
                    // allow selecting the same file again
                    e.currentTarget.value = "";
                  }}
                />
              </div>
              <Input
                id="logoUrl"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                className="mt-2"
                placeholder="https://.../logo.png"
                disabled={isLoading}
              />
            </div>
            <div>
              <Label htmlFor="themeJson">Theme JSON (CSS variables)</Label>
              <textarea
                id="themeJson"
                value={themeText}
                onChange={(e) => setThemeText(e.target.value)}
                className="mt-1 h-44 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                spellCheck={false}
                disabled={isLoading}
              />
              {themeJsonError && (
                <p className="mt-2 text-sm text-red-600">{themeJsonError}</p>
              )}
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoading || !parsedTheme}
                  onClick={() => {
                    if (!parsedTheme) return;
                    setThemeText(JSON.stringify(parsedTheme, null, 2));
                  }}
                >
                  Format JSON
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoading || !parsedTheme}
                  onClick={() => {
                    if (!parsedTheme) return;
                    applyCssVars(parsedTheme);
                    setSuccess("Preview applied (not saved).");
                  }}
                >
                  Preview Theme
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Localization */}
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Localization</h2>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="defaultLang">Default Language</Label>
              <select
                id="defaultLang"
                value={defaultLanguage}
                onChange={(e) => setDefaultLanguage(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border px-3 bg-background"
                disabled={isLoading}
              >
                <option value="en">English</option>
                <option value="sr">Serbian (Latin)</option>
              </select>
            </div>
            <div>
              <Label htmlFor="timezone">Default Timezone</Label>
              <select
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border px-3 bg-background"
                disabled={isLoading}
              >
                <option value="UTC">UTC</option>
                <option value="Europe/Belgrade">Europe/Belgrade</option>
                <option value="America/New_York">America/New York</option>
              </select>
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Email Notifications</h2>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="smtpHost">SMTP Host</Label>
              <Input id="smtpHost" placeholder="smtp.example.com" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="smtpPort">SMTP Port</Label>
              <Input id="smtpPort" placeholder="587" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="senderEmail">Sender Email</Label>
              <Input id="senderEmail" placeholder="noreply@example.com" className="mt-1" />
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Security</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Two-Factor Authentication</p>
                <p className="text-sm text-muted-foreground">Require 2FA for admin accounts</p>
              </div>
              <input type="checkbox" className="h-4 w-4" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Session Timeout</p>
                <p className="text-sm text-muted-foreground">Auto logout after inactivity</p>
              </div>
              <select className="h-9 rounded-md border px-3 bg-background">
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


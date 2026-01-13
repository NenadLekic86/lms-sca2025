"use client";

import { useRef, useState } from "react";
import { Settings, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Props = {
  orgId: string;
  orgLabel: string;
  initialLogoUrl: string | null;
};

export default function OrgSettingsClient({ orgId, orgLabel, initialLogoUrl }: Props) {
  const [logoUrl, setLogoUrl] = useState<string>(initialLogoUrl ?? "");
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function uploadLogo(file: File) {
    setError(null);
    setSuccess(null);
    setIsUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/organizations/${orgId}/logo`, { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to upload logo");
      if (body.logo_url) setLogoUrl(String(body.logo_url));
      setSuccess("Logo uploaded.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload logo");
    } finally {
      setIsUploading(false);
    }
  }

  async function removeLogo() {
    setError(null);
    setSuccess(null);
    setIsRemoving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/logo`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to remove logo");
      setLogoUrl("");
      setSuccess("Logo removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove logo");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <Settings className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold text-foreground">Organization Settings</h1>
          <p className="text-muted-foreground">Manage settings for your organization</p>
        </div>
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

      <div className="bg-card border rounded-lg p-6 shadow-sm">
        <div className="space-y-4">
          <div>
            <Label>Organization Logo</Label>
            <p className="text-sm text-muted-foreground mt-1">
              This logo will be shown on the organization dashboard for admins and members in this organization.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative h-16 w-32 bg-muted rounded flex items-center justify-center text-muted-foreground text-sm text-center overflow-hidden">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="Organization logo" className="h-full w-full object-contain" />
              ) : (
                orgLabel
              )}

              {logoUrl ? (
                <button
                  type="button"
                  className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/75 disabled:opacity-60"
                  title="Remove logo"
                  disabled={isUploading || isRemoving}
                  onClick={() => void removeLogo()}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/webp,image/svg,image/svg+xml"
              className="hidden"
              disabled={isUploading || isRemoving}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void uploadLogo(f);
                // allow selecting the same file again
                e.currentTarget.value = "";
              }}
            />

            <Button
              variant="outline"
              size="sm"
              disabled={isUploading || isRemoving}
              type="button"
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={16} className="mr-2" />
              {isUploading ? "Uploading..." : "Upload New"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Allowed: PNG, WebP, SVG. Max size: 2MB.
          </p>
        </div>
      </div>
    </div>
  );
}



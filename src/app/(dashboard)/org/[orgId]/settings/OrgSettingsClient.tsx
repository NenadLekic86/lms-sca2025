"use client";

import { useRef, useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Props = {
  orgId: string;
  orgLabel: string;
  initialLogoUrl: string | null;
};

export default function OrgSettingsClient({ orgId, orgLabel, initialLogoUrl }: Props) {
  const [logoUrl, setLogoUrl] = useState<string>(initialLogoUrl ?? "");
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isDraggingLogo, setIsDraggingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function uploadLogo(file: File) {
    setError(null);
    setSuccess(null);
    setIsUploading(true);
    const t = toast.loading("Uploading organization logo…");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/organizations/${orgId}/logo`, { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to upload logo");
      if (body.logo_url) setLogoUrl(String(body.logo_url));
      setSuccess("Logo uploaded.");
      toast.success("Organization logo uploaded.", { id: t });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to upload logo";
      setError(msg);
      toast.error(msg, { id: t });
    } finally {
      setIsUploading(false);
    }
  }

  async function removeLogo() {
    setError(null);
    setSuccess(null);
    setIsRemoving(true);
    const t = toast.loading("Removing organization logo…");
    try {
      const res = await fetch(`/api/organizations/${orgId}/logo`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to remove logo");
      setLogoUrl("");
      setSuccess("Logo removed.");
      toast.success("Organization logo removed.", { id: t });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to remove logo";
      setError(msg);
      toast.error(msg, { id: t });
    } finally {
      setIsRemoving(false);
    }
  }

  function handleLogoDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingLogo(false);
    if (isUploading || isRemoving) return;

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    const allowed = new Set(["image/png", "image/webp", "image/svg+xml"]);
    if (!allowed.has(file.type)) {
      setError("Please drop a PNG, WebP, or SVG file.");
      toast.error("Please drop a PNG, WebP, or SVG file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("File too large (max 2MB).");
      toast.error("File too large (max 2MB).");
      return;
    }

    void uploadLogo(file);
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

          {/* Current logo preview */}
          <div className="rounded-md border bg-background p-4">
            <div className="text-sm font-medium text-foreground mb-3">Current logo</div>
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt="Current organization logo"
                className="h-20 w-48 object-contain rounded-md border bg-muted/30"
              />
            ) : (
              <div className="h-20 w-48 rounded-md border bg-muted/30 flex items-center justify-center text-xs text-muted-foreground text-center px-2">
                No logo uploaded
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Logo upload</div>
              <div className="text-xs text-muted-foreground">
                Drag & drop a logo here, or click to browse. PNG / WebP / SVG, max 2MB.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!logoUrl || isUploading || isRemoving}
              onClick={() => void removeLogo()}
            >
              {isRemoving ? "Removing..." : "Remove"}
            </Button>
          </div>

          <div
            className={`rounded-md border border-dashed px-4 py-4 transition ${
              isDraggingLogo ? "border-primary bg-primary/10" : "border-muted-foreground/30 bg-muted/40"
            }`}
            role="button"
            tabIndex={0}
            aria-label="Upload organization logo"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!isUploading && !isRemoving) setIsDraggingLogo(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDraggingLogo(false);
            }}
            onDrop={handleLogoDrop}
          >
            <div className="flex items-center gap-4">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt="Organization logo"
                  className="h-14 w-14 rounded-md object-contain border bg-background"
                />
              ) : (
                <div className="h-14 w-14 rounded-md border flex items-center justify-center text-xs text-muted-foreground bg-background text-center px-1">
                  {orgLabel}
                </div>
              )}

              <div className="min-w-0">
                <div className="font-medium text-foreground">Drag & drop a logo here, or click to browse</div>
                <div className="text-xs text-muted-foreground">PNG / WebP / SVG, max 2MB.</div>
                {isUploading ? <div className="mt-1 text-xs text-muted-foreground">Uploading…</div> : null}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/webp,image/svg+xml"
                className="hidden"
                disabled={isUploading || isRemoving}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (!f) return;
                  void uploadLogo(f);
                  // allow selecting the same file again
                  e.currentTarget.value = "";
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}



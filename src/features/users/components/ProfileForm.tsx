'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";

type MeResponse = {
  user: {
    id: string;
    email: string;
    role: string;
    organization_id: string | null;
    full_name: string | null;
    avatar_url?: string | null;
  };
};

function normalizeFullName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

export function ProfileForm() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [fullName, setFullName] = useState("");
  const [originalFullName, setOriginalFullName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isRemovingAvatar, setIsRemovingAvatar] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [presetAvatars, setPresetAvatars] = useState<Array<{ name: string; url: string }>>([]);
  const [isLoadingPresets, setIsLoadingPresets] = useState(false);
  const [isSettingPreset, setIsSettingPreset] = useState(false);
  const [isPresetPickerOpen, setIsPresetPickerOpen] = useState(false);
  const presetPickerRef = useRef<HTMLDivElement | null>(null);

  const isDirty = useMemo(() => normalizeFullName(fullName) !== normalizeFullName(originalFullName), [fullName, originalFullName]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      setSuccess(null);
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as Partial<MeResponse> & { error?: string };
        if (!res.ok) throw new Error(body.error || "Failed to load profile");
        if (cancelled) return;

        const u = body.user!;
        setEmail(u.email || "");
        setRole(u.role || "");
        const initial = u.full_name ?? "";
        setFullName(initial);
        setOriginalFullName(initial);
        setAvatarUrl((u as { avatar_url?: string | null }).avatar_url ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load profile");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadPresets() {
      setIsLoadingPresets(true);
      try {
        const res = await fetch("/api/avatar-presets", { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          presets?: Array<{ name: string; url: string }>;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error || "Failed to load avatar presets");
        if (cancelled) return;
        setPresetAvatars(Array.isArray(body.presets) ? body.presets : []);
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setIsLoadingPresets(false);
      }
    }

    void loadPresets();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setIsSaving(true);
    try {
      const name = normalizeFullName(fullName);
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: name.length ? name : null }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<MeResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || "Failed to save");

      const saved = body.user?.full_name ?? "";
      setFullName(saved);
      setOriginalFullName(saved);
      setAvatarUrl((body.user as { avatar_url?: string | null } | undefined)?.avatar_url ?? avatarUrl);
      setSuccess("Saved.");

      // Let the rest of the app refresh user state + server components.
      window.dispatchEvent(new Event("profile:updated"));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUploadAvatar() {
    if (!avatarFile) return;
    setError(null);
    setSuccess(null);
    setIsUploadingAvatar(true);
    try {
      const form = new FormData();
      form.append("file", avatarFile);
      const res = await fetch("/api/me/avatar", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string; avatar_url?: string | null };
      if (!res.ok) throw new Error(body.error || "Failed to upload avatar");

      setAvatarUrl(body.avatar_url ?? null);
      setAvatarFile(null);
      setSuccess("Avatar updated.");
      window.dispatchEvent(new Event("profile:updated"));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload avatar");
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  async function handleRemoveAvatar() {
    setError(null);
    setSuccess(null);
    setIsRemovingAvatar(true);
    try {
      const res = await fetch("/api/me/avatar", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; avatar_url?: string | null };
      if (!res.ok) throw new Error(body.error || "Failed to remove avatar");

      setAvatarUrl(null);
      setAvatarFile(null);
      setSuccess("Avatar removed.");
      window.dispatchEvent(new Event("profile:updated"));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove avatar");
    } finally {
      setIsRemovingAvatar(false);
    }
  }

  async function handleSetPreset(name: string) {
    setError(null);
    setSuccess(null);
    setIsSettingPreset(true);
    try {
      const res = await fetch("/api/me/avatar-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; avatar_url?: string | null };
      if (!res.ok) throw new Error(body.error || "Failed to set avatar preset");
      setAvatarUrl(body.avatar_url ?? null);
      setAvatarFile(null);
      setSuccess("Avatar updated.");
      setIsPresetPickerOpen(false);
      window.dispatchEvent(new Event("profile:updated"));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set avatar preset");
    } finally {
      setIsSettingPreset(false);
    }
  }

  // Close preset picker on outside click / escape
  useEffect(() => {
    if (!isPresetPickerOpen) return;

    const onMouseDown = (e: MouseEvent) => {
      const el = presetPickerRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setIsPresetPickerOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsPresetPickerOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isPresetPickerOpen]);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Profile</h1>
        <p className="text-muted-foreground">Update your account details.</p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-2">
            <Label>Avatar</Label>
            <div className="flex items-center gap-3">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="h-14 w-14 rounded-full object-cover border"
                />
              ) : (
                <div className="h-14 w-14 rounded-full border flex items-center justify-center text-xs text-muted-foreground">
                  —
                </div>
              )}
              <div className="space-y-2">
                <Input
                  type="file"
                  accept="image/png,image/webp,image/jpeg,image/jpg"
                  disabled={isLoading || isSaving || isUploadingAvatar || isRemovingAvatar}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setAvatarFile(f);
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!avatarFile || isLoading || isUploadingAvatar || isRemovingAvatar || isSettingPreset}
                    onClick={handleUploadAvatar}
                  >
                    {isUploadingAvatar ? "Uploading..." : "Upload"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!avatarUrl || isLoading || isUploadingAvatar || isRemovingAvatar || isSettingPreset}
                    onClick={handleRemoveAvatar}
                  >
                    {isRemovingAvatar ? "Removing..." : "Remove"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  PNG / JPG / WebP, max 2MB.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2">
          <Label>Preset avatar</Label>
          {isLoadingPresets ? (
            <div className="text-sm text-muted-foreground">Loading presets…</div>
          ) : presetAvatars.length === 0 ? (
            <div className="text-sm text-muted-foreground">No preset avatars available.</div>
          ) : (
            <div ref={presetPickerRef} className="relative">
              {(() => {
                const firstPreset = presetAvatars[0]?.url ?? null;
                const previewUrl = avatarUrl ?? firstPreset;
                const isDisabled = isLoading || isSaving || isUploadingAvatar || isRemovingAvatar || isSettingPreset;

                return (
                  <>
                    <button
                      type="button"
                      className={`inline-flex items-center gap-3 rounded-md border bg-white px-3 py-2 hover:cursor-pointer ${
                        isDisabled ? "opacity-60 cursor-not-allowed" : ""
                      }`}
                      disabled={isDisabled}
                      onClick={() => setIsPresetPickerOpen((v) => !v)}
                      aria-label="Choose a preset avatar"
                      aria-expanded={isPresetPickerOpen}
                    >
                      {previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previewUrl} alt="Preset avatar" className="h-10 w-10 rounded-full object-cover border" />
                      ) : (
                        <div className="h-10 w-10 rounded-full border flex items-center justify-center text-xs text-muted-foreground">
                          —
                        </div>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {isPresetPickerOpen ? "Close" : "Choose preset"}
                      </span>
                    </button>

                    {isPresetPickerOpen ? (
                      <div className="absolute z-20 mt-2 w-[415px] max-w-[90vw] rounded-lg border bg-white shadow-lg p-3">
                        <div className="grid grid-cols-7 gap-2">
                          {presetAvatars.map((p) => {
                            const isActive = !!avatarUrl && (avatarUrl === p.url || avatarUrl.endsWith(p.url));
                            return (
                              <button
                                key={p.name}
                                type="button"
                                className={`rounded-full border p-0.5 transition-colors hover:cursor-pointer m-auto ${
                                  isActive ? "border-primary" : "border-transparent hover:border-muted-foreground/30"
                                } ${isSettingPreset ? "opacity-60 cursor-not-allowed" : ""}`}
                                disabled={isDisabled}
                                onClick={() => handleSetPreset(p.name)}
                                title={p.name}
                                aria-label={`Use preset avatar ${p.name}`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={p.url} alt={p.name} className="h-10 w-10 rounded-full object-cover" />
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Presets are built-in (no upload needed).
                        </p>
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={email} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Input id="role" value={role} disabled />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="fullName">Full Name (optional)</Label>
          <Input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="e.g. John Smith"
            disabled={isLoading || isSaving}
          />
          <p className="text-xs text-muted-foreground">
            This is used for greetings like “Welcome back, John Smith”.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isLoading || isSaving || !isDirty}
            onClick={() => {
              setFullName(originalFullName);
              setSuccess(null);
              setError(null);
            }}
          >
            Reset
          </Button>
          <Button type="button" disabled={isLoading || isSaving || !isDirty} onClick={handleSave}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}



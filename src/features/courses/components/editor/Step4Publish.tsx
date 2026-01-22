import { useEffect, useMemo, useState } from "react";
import { Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/api";

type VisibilityScope = "all" | "organizations";

type OrganizationRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
  is_active?: boolean | null;
};

type TemplateRow = {
  id: string;
  created_at: string;
  course_id: string;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function Step4Publish({
  courseId,
  actorRole,
  canManageVisibility,
  visibilityScope,
  setVisibilityScope,
  selectedOrgIds,
  setSelectedOrgIds,
  isPublished,
  setIsPublished,
  canPublishNow,
  onCompletionChange,
  onSavePublishSettings,
  hideSaveButton,
}: {
  courseId: string;
  actorRole: "super_admin" | "system_admin" | "organization_admin" | "member";
  canManageVisibility: boolean;
  visibilityScope: VisibilityScope;
  setVisibilityScope: (v: VisibilityScope) => void;
  selectedOrgIds: string[];
  setSelectedOrgIds: (ids: string[]) => void;
  isPublished: boolean;
  setIsPublished: (v: boolean) => void;
  canPublishNow: boolean;
  onCompletionChange: (ok: boolean) => void;
  onSavePublishSettings: () => void;
  hideSaveButton?: boolean;
}) {
  const [orgs, setOrgs] = useState<OrganizationRow[]>([]);
  const [orgSearch, setOrgSearch] = useState("");
  const [orgsLoading, setOrgsLoading] = useState(false);

  const [template, setTemplate] = useState<TemplateRow | null>(null);
  const [tplFile, setTplFile] = useState<File | null>(null);
  const [tplLoading, setTplLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showOrgSelector = canManageVisibility && visibilityScope === "organizations";

  const filteredOrgs = useMemo(() => {
    const q = orgSearch.trim().toLowerCase();
    const base = orgs;
    if (!q) return base;
    return base.filter((o) => {
      const name = (o.name ?? "").toLowerCase();
      const slug = (o.slug ?? "").toLowerCase();
      return name.includes(q) || slug.includes(q) || o.id.toLowerCase().includes(q);
    });
  }, [orgSearch, orgs]);

  const visibilityOk = !showOrgSelector || selectedOrgIds.length > 0;
  const templateOk = Boolean(template);
  const stepOk = templateOk && visibilityOk;

  useEffect(() => {
    onCompletionChange(stepOk);
  }, [onCompletionChange, stepOk]);

  const toggleOrg = (id: string) => {
    setSelectedOrgIds(selectedOrgIds.includes(id) ? selectedOrgIds.filter((x) => x !== id) : [...selectedOrgIds, id]);
  };

  async function loadTemplate() {
    setError(null);
    try {
      const { data: body } = await fetchJson<{ template?: TemplateRow | null }>(`/api/courses/${courseId}/certificate-template`, {
        cache: "no-store",
      });
      setTemplate(body.template ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load certificate template");
    }
  }

  async function loadOrgs() {
    if (!showOrgSelector) return;
    setOrgsLoading(true);
    setError(null);
    try {
      const { data: body } = await fetchJson<{ organizations?: OrganizationRow[] }>("/api/organizations", { cache: "no-store" });
      setOrgs(Array.isArray(body.organizations) ? body.organizations : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organizations");
    } finally {
      setOrgsLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  useEffect(() => {
    void loadOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOrgSelector]);

  async function uploadTemplate() {
    if (!tplFile) return;
    setTplLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", tplFile);
      await fetchJson<Record<string, unknown>>(`/api/courses/${courseId}/certificate-template`, { method: "POST", body: form });
      setTplFile(null);
      await loadTemplate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload template");
    } finally {
      setTplLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div>
            <div className="text-lg font-semibold text-foreground">Certificate template</div>
            <p className="text-sm text-muted-foreground">Upload a certificate template (max 10MB).</p>
          </div>

          {template ? (
            <div className="rounded-md border bg-background p-3 space-y-2">
              <div className="text-sm font-medium text-foreground">{template.file_name}</div>
              <div className="text-xs text-muted-foreground">
                {template.mime_type} • {formatBytes(template.size_bytes)}
              </div>
              <div className="text-xs text-muted-foreground">
                Template is saved. (Preview/download will be added when we build member completion flow.)
              </div>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              No certificate template uploaded yet.
            </div>
          )}

          <div className="space-y-2">
            <Label>Upload</Label>
            <Input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => setTplFile(e.target.files?.[0] ?? null)}
            />
            <Button variant="secondary" onClick={() => void uploadTemplate()} disabled={!tplFile || tplLoading}>
              {tplLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload template
            </Button>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div>
            <div className="text-lg font-semibold text-foreground">Publish settings</div>
            <p className="text-sm text-muted-foreground">
              Finalize visibility and publish the course.
            </p>
          </div>

          <div className="rounded-lg border bg-background p-4 space-y-3">
            <div className="font-medium text-foreground">Publishing</div>
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm text-muted-foreground">
                {isPublished ? "This course is visible to users." : "This course is still a draft."}
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={isPublished}
                  disabled={!canPublishNow && !isPublished}
                  onChange={(e) => setIsPublished(e.target.checked)}
                />
                Published
              </label>
            </div>
            {!canPublishNow ? (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Publishing is locked until Steps 1–3 and the certificate template are complete.
              </div>
            ) : null}
          </div>

          {canManageVisibility ? (
            <div className="rounded-lg border bg-background p-4 space-y-3">
              <div className="font-medium text-foreground">Visibility</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="visibility"
                    className="accent-primary"
                    checked={visibilityScope === "all"}
                    onChange={() => setVisibilityScope("all")}
                  />
                  Visible to all organizations
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="visibility"
                    className="accent-primary"
                    checked={visibilityScope === "organizations"}
                    onChange={() => setVisibilityScope("organizations")}
                  />
                  Visible to selected organizations
                </label>
              </div>

              {showOrgSelector ? (
                <div className="pt-3 border-t space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="orgSearch" className="text-sm text-muted-foreground">
                      Organizations
                    </Label>
                    <span className="text-xs text-muted-foreground">{selectedOrgIds.length} selected</span>
                  </div>
                  <Input
                    id="orgSearch"
                    value={orgSearch}
                    onChange={(e) => setOrgSearch(e.target.value)}
                    placeholder="Search orgs…"
                  />

                  {orgsLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading organizations…
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-auto rounded-md border bg-background p-2 space-y-1">
                      {filteredOrgs.length === 0 ? (
                        <div className="px-2 py-2 text-sm text-muted-foreground">No organizations found.</div>
                      ) : (
                        filteredOrgs.map((o) => {
                          const label = o.name ?? o.slug ?? o.id;
                          const checked = selectedOrgIds.includes(o.id);
                          return (
                            <label
                              key={o.id}
                              className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={checked}
                                onChange={() => toggleOrg(o.id)}
                              />
                              <span className="text-sm">{label}</span>
                              {o.is_active === false ? (
                                <span className="ml-auto text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">
                                  inactive
                                </span>
                              ) : null}
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}

                  {!visibilityOk ? (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                      Select at least one organization before publishing.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border bg-background p-4">
              <div className="font-medium text-foreground">Visibility</div>
              <div className="text-sm text-muted-foreground">
                {actorRole === "organization_admin"
                  ? "Org-admin courses are visible only to organizations."
                  : "Visibility settings not available."}
              </div>
            </div>
          )}

          <div className="rounded-lg border bg-background p-4 space-y-2">
            <div className="font-medium text-foreground">Tip</div>
            <p className="text-sm text-muted-foreground">
              Publishing will be blocked until resources, assessment questions, and certificate template are configured.
            </p>
          </div>

          {!hideSaveButton ? (
            <Button onClick={onSavePublishSettings} disabled={tplLoading || orgsLoading}>
              Save publish settings
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}


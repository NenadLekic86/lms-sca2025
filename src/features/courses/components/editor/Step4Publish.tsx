import { useEffect, useState } from "react";
import { Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/api";

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
  isPublished,
  setIsPublished,
  canPublishNow,
  onCompletionChange,
  onSavePublishSettings,
  hideSaveButton,
}: {
  courseId: string;
  actorRole: "super_admin" | "system_admin" | "organization_admin" | "member";
  isPublished: boolean;
  setIsPublished: (v: boolean) => void;
  canPublishNow: boolean;
  onCompletionChange: (ok: boolean) => void;
  onSavePublishSettings: () => void;
  hideSaveButton?: boolean;
}) {
  const [template, setTemplate] = useState<TemplateRow | null>(null);
  const [tplFile, setTplFile] = useState<File | null>(null);
  const [tplLoading, setTplLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templateOk = Boolean(template);
  const stepOk = templateOk;

  useEffect(() => {
    onCompletionChange(stepOk);
  }, [onCompletionChange, stepOk]);

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

  useEffect(() => {
    void loadTemplate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

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

          <div className="rounded-lg border bg-background p-4">
            <div className="font-medium text-foreground">Visibility</div>
            <div className="text-sm text-muted-foreground">
              {actorRole === "organization_admin"
                ? "This course is visible only inside your organization."
                : "Course visibility is managed by organization ownership."}
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4 space-y-2">
            <div className="font-medium text-foreground">Tip</div>
            <p className="text-sm text-muted-foreground">
              Publishing will be blocked until resources, assessment questions, and certificate template are configured.
            </p>
          </div>

          {!hideSaveButton ? <Button onClick={onSavePublishSettings} disabled={tplLoading}>Save publish settings</Button> : null}
        </div>
      </div>
    </div>
  );
}


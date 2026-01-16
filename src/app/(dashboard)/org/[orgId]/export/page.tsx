import { Download, FileSpreadsheet, FileText, Calendar, Users, BookOpen, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notFound, redirect } from "next/navigation";
import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

type ExportAuditRow = {
  id: string;
  created_at?: string | null;
  action?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  metadata?: unknown;
};

type SearchParams = Record<string, string | string[] | undefined>;
function spGet(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
  return null;
}

function buildPager(current: number, total: number): Array<number | "ellipsis"> {
  const t = Math.max(1, Math.floor(total));
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);

  const pages = new Set<number>([1, t, c, c - 1, c + 1]);
  const list = Array.from(pages).filter((p) => p >= 1 && p <= t).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const prev = list[i - 1];
    if (typeof prev === "number" && p - prev > 1) out.push("ellipsis");
    out.push(p);
  }
  return out;
}

export default async function OrgExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const sp = (await searchParams) ?? {};
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id; // UUID (DB/API)
  const orgSlug = org.slug; // canonical slug (links)

  if (user.role === "member") redirect(`/org/${orgSlug}`);
  if (user.role === "organization_admin") {
    if (!user.organization_id || user.organization_id !== orgId) redirect("/unauthorized");
  }

  // Recent exports: read from audit_logs (we log export downloads there).
  const admin = createAdminSupabaseClient();
  const exportActions = ["export_users", "export_enrollments", "export_certificates", "export_courses", "export_organizations"];

  const exportsPageSize = 20;
  const exportsPageRaw = Number(spGet(sp, "exports_page") ?? "1");
  const exportsPageSafe = Number.isFinite(exportsPageRaw) && exportsPageRaw > 0 ? Math.floor(exportsPageRaw) : 1;

  const { count: exportsCountRaw, error: exportsCountError } = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .in("action", exportActions)
    .eq("entity", "organizations")
    .eq("entity_id", orgId);

  const exportsTotalCount = typeof exportsCountRaw === "number" ? exportsCountRaw : 0;
  const exportsTotalPages = exportsTotalCount > 0 ? Math.max(1, Math.ceil(exportsTotalCount / exportsPageSize)) : 1;
  const exportsCurrent = exportsCountError ? exportsPageSafe : Math.min(Math.max(1, exportsPageSafe), exportsTotalPages);

  const exportsFromIdx = (Math.max(1, exportsCurrent) - 1) * exportsPageSize;
  const exportsToIdx = exportsFromIdx + exportsPageSize - 1;

  const { data: auditData, error: auditError } = await admin
    .from("audit_logs")
    .select("id, created_at, action, actor_email, actor_role, metadata")
    .in("action", exportActions)
    .eq("entity", "organizations")
    .eq("entity_id", orgId)
    .order("created_at", { ascending: false })
    .range(exportsFromIdx, exportsToIdx);

  const recentExports = (Array.isArray(auditData) ? auditData : []) as ExportAuditRow[];

  const exportsHref = (p: number) => {
    const u = new URLSearchParams();
    u.set("exports_page", String(p));
    return `?${u.toString()}`;
  };

  const roleLabel = (role: string | null) => {
    switch (role) {
      case "super_admin":
        return "Super Admin";
      case "system_admin":
        return "System Admin";
      case "organization_admin":
        return "Organization Admin";
      case "member":
        return "Member";
      default:
        return role ?? "";
    }
  };

  const exportLabel = (action: string | null) => {
    switch (action) {
      case "export_users":
        return "Users (CSV)";
      case "export_enrollments":
        return "Course progress / Enrollments (CSV)";
      case "export_certificates":
        return "Certificates (CSV)";
      case "export_courses":
        return "Courses (CSV)";
      case "export_organizations":
        return "Organizations (CSV)";
      default:
        return action ?? "Export";
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Download className="h-8 w-8 text-primary shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Export Data</h1>
            <p className="text-muted-foreground">Export your organization&apos;s data</p>
          </div>
        </div>
        <Button variant="outline" className="gap-2 shrink-0" disabled title="Coming soon">
          <Calendar className="h-4 w-4" />
          Schedule Export
        </Button>
      </div>

      {/* Export Options Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <div className="h-14 w-14 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">Users Export</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">Export all users in your organization</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2" asChild>
                <a href={`/api/exports/users?orgId=${encodeURIComponent(orgId)}`} target="_blank" rel="noreferrer">
                  <FileSpreadsheet className="h-4 w-4" />
                  CSV
                </a>
              </Button>
              <Button variant="outline" size="sm" className="gap-2" disabled title="Coming soon">
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </Button>
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <div className="h-14 w-14 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              <BookOpen className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">Course Progress</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">Export enrollment results + assessment time</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2" asChild>
                <a href={`/api/reports/enrollments/export?orgId=${encodeURIComponent(orgId)}`} target="_blank" rel="noreferrer">
                  <FileSpreadsheet className="h-4 w-4" />
                  CSV
                </a>
              </Button>
              <Button variant="outline" size="sm" className="gap-2" disabled title="Coming soon">
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </Button>
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <div className="h-14 w-14 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              <Award className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">Certificates Export</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">Export all issued certificates</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2" asChild>
                <a href={`/api/exports/certificates?orgId=${encodeURIComponent(orgId)}`} target="_blank" rel="noreferrer">
                  <FileSpreadsheet className="h-4 w-4" />
                  CSV
                </a>
              </Button>
              <Button variant="outline" size="sm" className="gap-2" disabled title="Coming soon">
                <FileText className="h-4 w-4" />
                PDF
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Exports */}
      <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
        <div className="p-6 border-b">
          <h2 className="text-lg font-semibold text-foreground">Recent Exports</h2>
          <p className="text-sm text-muted-foreground">Your recent export history</p>
        </div>

        {auditError ? (
          <div className="px-6 py-4 text-sm text-destructive">
            Failed to load export history: {auditError.message}
          </div>
        ) : exportsCountError ? (
          <div className="px-6 py-4 text-sm text-amber-800 bg-amber-50 border-t border-amber-200">
            Export history count not available: {exportsCountError.message}
          </div>
        ) : recentExports.length === 0 ? (
          <div className="px-6 py-10 text-center text-muted-foreground">
            No export history yet. Your CSV exports will appear here after you download them above.
          </div>
        ) : (
          <>
            <div className="w-full overflow-x-auto">
              <table className="min-w-max w-full">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Timestamp</th>
                  <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">What</th>
                  <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Who</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recentExports.map((r) => {
                  const who = r.actor_email
                    ? `${r.actor_email}${r.actor_role ? ` (${roleLabel(r.actor_role)})` : ""}`
                    : "—";
                  const when = r.created_at ? new Date(r.created_at).toLocaleString() : "—";
                  return (
                    <tr key={r.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4 text-sm text-muted-foreground font-mono whitespace-nowrap">{when}</td>
                      <td className="px-6 py-4 text-sm text-foreground">{exportLabel(r.action ?? null)}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">{who}</td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          </>
        )}

        {/* Pagination */}
        {!auditError && !exportsCountError && exportsTotalCount > 0 ? (
          <div className="px-6 py-4 border-t flex items-center justify-between gap-3 text-sm">
            <div className="text-muted-foreground">
              Showing {exportsFromIdx + 1}–{Math.min(exportsFromIdx + recentExports.length, exportsTotalCount)} of {exportsTotalCount}
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const onlyOne = exportsTotalPages <= 1;
                const prevDisabled = onlyOne || exportsCurrent <= 1;
                const nextDisabled = onlyOne || exportsCurrent >= exportsTotalPages;
                const pager = buildPager(exportsCurrent, exportsTotalPages);

                return (
                  <>
                    {prevDisabled ? (
                      <Button variant="outline" disabled>
                        Prev
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <a href={exportsHref(exportsCurrent - 1)}>Prev</a>
                      </Button>
                    )}

                    <div className="flex items-center gap-1">
                      {pager.map((p, idx) =>
                        p === "ellipsis" ? (
                          <span key={`e-${idx}`} className="px-2 text-muted-foreground select-none">
                            …
                          </span>
                        ) : p === exportsCurrent ? (
                          <Button key={p} disabled>
                            {p}
                          </Button>
                        ) : (
                          <Button key={p} asChild variant="outline">
                            <a href={exportsHref(p)}>{p}</a>
                          </Button>
                        )
                      )}
                    </div>

                    {nextDisabled ? (
                      <Button variant="outline" disabled>
                        Next
                      </Button>
                    ) : (
                      <Button asChild variant="outline">
                        <a href={exportsHref(exportsCurrent + 1)}>Next</a>
                      </Button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


'use client';

import { Building2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMemo, useState } from "react";
import { CreateOrganizationForm, useOrganizations } from "@/features/organizations";
import { toast } from "sonner";

// Legacy implementation kept intentionally (dormant).
// Primary Organizations page now uses OrganizationsTableV2.
export default function OrganizationsPageLegacy() {
  const { organizations, countsErrors, isLoading, error, createOrganization, disableOrganization, enableOrganization } =
    useOrganizations();
  const [query, setQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [togglingOrgId, setTogglingOrgId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return organizations;
    return organizations.filter((o) => {
      const name = (o.name || "").toLowerCase();
      const slug = (o.slug || "").toLowerCase();
      const id = (o.id || "").toLowerCase();
      return name.includes(q) || slug.includes(q) || id.includes(q);
    });
  }, [organizations, query]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Building2 className="h-8 w-8 text-primary shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Organizations</h1>
            <p className="text-muted-foreground">Manage all organizations in the system</p>
          </div>
        </div>
        <Button className="flex items-center gap-2 shrink-0" onClick={() => setIsCreateOpen((v) => !v)}>
          <Plus size={18} />
          {isCreateOpen ? "Close" : "Add Organization"}
        </Button>
      </div>

      {isCreateOpen ? (
        <div className="bg-card border rounded-lg p-6 shadow-sm">
          <CreateOrganizationForm
            onCreate={async (input) => {
              const t = toast.loading("Creating organization…");
              try {
                const res = await createOrganization(input);
                toast.success(res.message || "Organization created.", { id: t });
                setIsCreateOpen(false);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Failed to create organization", { id: t });
              }
            }}
          />
        </div>
      ) : null}

      {countsErrors?.courses ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Courses counts not available: {countsErrors.courses}
        </div>
      ) : null}
      {countsErrors?.certificates ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Certificates counts not available: {countsErrors.certificates}
        </div>
      ) : null}

      {/* Search & Filters */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search organizations..."
            className="pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load organizations: {error.message}
        </div>
      ) : null}

      {/* Organizations Table */}
      <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
        <div className="w-full overflow-x-auto">
          <table className="min-w-max w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Name</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Slug</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Users (A / D / T)</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Courses</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Certificates</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Status</th>
                <th className="text-left px-6 py-3 text-sm font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                    Loading organizations...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                    No organizations found.
                  </td>
                </tr>
              ) : (
                filtered.map((org) => (
                  <tr key={org.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4 font-medium">{org.name ?? "(no name)"}</td>
                    <td className="px-6 py-4 text-muted-foreground font-mono">{org.slug ?? "-"}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {(org.users_active_count ?? 0)} / {(org.users_disabled_count ?? 0)} / {(org.users_count ?? 0)}
                    </td>
                    <td className="px-6 py-4">{org.courses_count ?? 0}</td>
                    <td className="px-6 py-4">{org.certificates_count ?? 0}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2 py-1 text-xs font-medium rounded-full ${
                          org.is_active === false ? "bg-gray-100 text-gray-700" : "bg-green-100 text-green-700"
                        }`}
                      >
                        {org.is_active === false ? "Inactive" : "Active"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {org.is_active === false ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-green-600 text-green-700 hover:bg-green-50"
                          disabled={togglingOrgId === org.id}
                          onClick={async () => {
                            if (!confirm("Enable this organization? Users in it will be able to log in again.")) return;
                            setTogglingOrgId(org.id);
                            const t = toast.loading("Enabling organization…");
                            try {
                              const res = await enableOrganization(org.id);
                              toast.success(res.message || "Organization enabled.", { id: t });
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Failed to enable organization", { id: t });
                            } finally {
                              setTogglingOrgId(null);
                            }
                          }}
                        >
                          {togglingOrgId === org.id ? "Enabling…" : "Enable"}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="bg-red-600 text-white hover:bg-red-700"
                          disabled={togglingOrgId === org.id}
                          onClick={async () => {
                            if (!confirm("Disable this organization? This will disable ALL users in it immediately.")) return;
                            setTogglingOrgId(org.id);
                            const t = toast.loading("Disabling organization…");
                            try {
                              const res = await disableOrganization(org.id);
                              toast.success(res.message || "Organization disabled.", { id: t });
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Failed to disable organization", { id: t });
                            } finally {
                              setTogglingOrgId(null);
                            }
                          }}
                        >
                          {togglingOrgId === org.id ? "Disabling…" : "Disable"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


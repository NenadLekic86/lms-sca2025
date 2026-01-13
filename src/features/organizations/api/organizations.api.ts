export type Organization = {
  id: string;
  name?: string | null;
  slug?: string | null;
  created_at?: string | null;
  is_active?: boolean | null;
  users_count?: number;
  users_active_count?: number;
  users_disabled_count?: number;
  courses_count?: number;
  certificates_count?: number;
};

export type GetOrganizationsResponse = {
  organizations: Organization[];
  counts_errors?: {
    users: string | null;
    courses: string | null;
    certificates?: string | null;
  };
};

export type CreateOrganizationResponse = {
  organization: Organization;
};

export const organizationsApi = {
  async getOrganizations(options?: { includeCounts?: boolean }): Promise<GetOrganizationsResponse> {
    const url = options?.includeCounts ? "/api/organizations?include_counts=1" : "/api/organizations";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to load organizations");
    }
    return res.json();
  },

  async createOrganization(input: { name: string; slug?: string }): Promise<CreateOrganizationResponse> {
    const res = await fetch("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to create organization");
    }
    return res.json();
  },

  async disableOrganization(orgId: string): Promise<{ message: string; organization_id: string }> {
    const res = await fetch(`/api/organizations/${orgId}/disable`, { method: "PATCH" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to disable organization");
    }
    return res.json();
  },

  async enableOrganization(orgId: string): Promise<{ message: string; organization_id: string }> {
    const res = await fetch(`/api/organizations/${orgId}/enable`, { method: "PATCH" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Failed to enable organization");
    }
    return res.json();
  },
};



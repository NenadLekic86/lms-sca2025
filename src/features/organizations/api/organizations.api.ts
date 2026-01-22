import { fetchJson } from "@/lib/api";

type ApiResult<T> = T & { message?: string };

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
    const { data } = await fetchJson<GetOrganizationsResponse>(url, { cache: "no-store" });
    return data;
  },

  async createOrganization(input: { name: string; slug?: string }): Promise<ApiResult<CreateOrganizationResponse>> {
    const { data, message } = await fetchJson<CreateOrganizationResponse>("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return { ...data, message };
  },

  async disableOrganization(orgId: string): Promise<ApiResult<{ organization_id: string }>> {
    const { data, message } = await fetchJson<{ organization_id: string }>(`/api/organizations/${orgId}/disable`, { method: "PATCH" });
    return { ...data, message };
  },

  async enableOrganization(orgId: string): Promise<ApiResult<{ organization_id: string }>> {
    const { data, message } = await fetchJson<{ organization_id: string }>(`/api/organizations/${orgId}/enable`, { method: "PATCH" });
    return { ...data, message };
  },
};



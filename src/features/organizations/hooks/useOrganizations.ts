'use client';

import { useCallback, useEffect, useState } from "react";
import { organizationsApi, type Organization } from "../api/organizations.api";

export function useOrganizations(options?: { enabled?: boolean; includeCounts?: boolean }) {
  const enabled = options?.enabled ?? true;
  const includeCounts = options?.includeCounts ?? true;
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [countsErrors, setCountsErrors] = useState<{ users: string | null; courses: string | null; certificates?: string | null } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchOrganizations = useCallback(async () => {
    if (!enabled) {
      setOrganizations([]);
      setCountsErrors(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    try {
      setIsLoading(true);
      const data = await organizationsApi.getOrganizations({ includeCounts });
      setOrganizations(data.organizations);
      setCountsErrors(data.counts_errors ?? null);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  }, [enabled, includeCounts]);

  useEffect(() => {
    void fetchOrganizations();
  }, [fetchOrganizations]);

  const createOrganization = useCallback(async (input: { name: string; slug?: string }) => {
    const res = await organizationsApi.createOrganization(input);
    await fetchOrganizations();
    return res;
  }, [fetchOrganizations]);

  const disableOrganization = useCallback(async (orgId: string) => {
    const res = await organizationsApi.disableOrganization(orgId);
    setOrganizations((prev) => prev.map((o) => (o.id === orgId ? { ...o, is_active: false } : o)));
    return res;
  }, []);

  const enableOrganization = useCallback(async (orgId: string) => {
    const res = await organizationsApi.enableOrganization(orgId);
    setOrganizations((prev) => prev.map((o) => (o.id === orgId ? { ...o, is_active: true } : o)));
    return res;
  }, []);

  return { organizations, countsErrors, isLoading, error, refetch: fetchOrganizations, createOrganization, disableOrganization, enableOrganization };
}



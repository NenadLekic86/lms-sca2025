import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/supabase/server';
import { resolveOrgKey } from '@/lib/organizations/resolveOrgKey';
import { notFound } from 'next/navigation';

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId: orgKey } = await params;
  const { user, error } = await getServerUser();

  // Not logged in → redirect to login
  if (!user || error) {
    redirect('/');
  }

  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    // For org-scoped roles: avoid leaking existence; treat as unauthorized.
    if (user.role === "organization_admin" || user.role === "member") {
      redirect('/unauthorized');
    }
    // For system/super: show a real 404.
    notFound();
  }

  // super_admin and system_admin can access any org
  if (['super_admin', 'system_admin'].includes(user.role)) {
    return <>{children}</>;
  }

  // organization_admin and member must belong to this org
  if (['organization_admin', 'member'].includes(user.role)) {
    if (!user.organization_id || user.organization_id !== org.id) {
      redirect('/unauthorized');
    }
    return <>{children}</>;
  }

  // Unknown role
  redirect('/unauthorized');
}


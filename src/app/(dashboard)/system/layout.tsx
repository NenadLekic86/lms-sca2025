import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/supabase/server';

export default async function SystemLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, error } = await getServerUser();

  // Not logged in → redirect to login
  if (!user || error) {
    redirect('/');
  }

  // super_admin and system_admin can access /system routes
  if (!['super_admin', 'system_admin'].includes(user.role)) {
    redirect('/unauthorized');
  }

  return <>{children}</>;
}


import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/supabase/server';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, error } = await getServerUser();

  // Not logged in → redirect to login
  if (!user || error) {
    redirect('/');
  }

  // Only super_admin can access /admin routes
  if (user.role !== 'super_admin') {
    redirect('/unauthorized');
  }

  return <>{children}</>;
}


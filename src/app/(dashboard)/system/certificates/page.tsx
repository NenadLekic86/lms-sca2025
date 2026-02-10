import { createAdminSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { CertificatesTableV2, type CertificateRowV2 } from "@/features/certificates";

type OrganizationRow = { id: string; name?: string | null; slug?: string | null };
type CourseRow = { id: string; title?: string | null };
type UserRow = { id: string; email?: string | null; full_name?: string | null };
type CertificateRow = {
  id: string;
  user_id?: string | null;
  course_id?: string | null;
  organization_id?: string | null;
  issued_at?: string | null;
  created_at?: string | null;
  status?: string | null;
  expires_at?: string | null;
};

export default async function SystemCertificatesPage() {
  const { user, error } = await getServerUser();
  if (error || !user) return null;
  if (!["super_admin", "system_admin"].includes(user.role)) return null;

  const admin = createAdminSupabaseClient();

  const { data: certData, error: certError } = await admin
    .from("certificates")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  const certificates = (Array.isArray(certData) ? certData : []) as CertificateRow[];

  // Hydrate labels only for the currently-visible rows (pure performance).
  const orgIds = Array.from(
    new Set(
      certificates
        .map((c) => c.organization_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );
  const courseIds = Array.from(
    new Set(
      certificates
        .map((c) => c.course_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );
  const userIds = Array.from(
    new Set(
      certificates
        .map((c) => c.user_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );

  const [{ data: orgsData }, { data: coursesData }, { data: usersData }] = await Promise.all([
    orgIds.length > 0 ? admin.from("organizations").select("id, name, slug").in("id", orgIds) : Promise.resolve({ data: [] }),
    courseIds.length > 0 ? admin.from("courses").select("id, title").in("id", courseIds) : Promise.resolve({ data: [] }),
    userIds.length > 0 ? admin.from("users").select("id, email, full_name").in("id", userIds) : Promise.resolve({ data: [] }),
  ]);

  const orgMap = new Map<string, OrganizationRow>();
  (Array.isArray(orgsData) ? (orgsData as OrganizationRow[]) : []).forEach((o) => orgMap.set(o.id, o));

  const courseMap = new Map<string, CourseRow>();
  (Array.isArray(coursesData) ? (coursesData as CourseRow[]) : []).forEach((c) => courseMap.set(c.id, c));

  const userMap = new Map<string, UserRow>();
  (Array.isArray(usersData) ? (usersData as UserRow[]) : []).forEach((u) => userMap.set(u.id, u));

  const rows: CertificateRowV2[] = certificates.map((cert) => {
    const u = cert.user_id ? userMap.get(cert.user_id) : null;
    const c = cert.course_id ? courseMap.get(cert.course_id) : null;
    const o = cert.organization_id ? orgMap.get(cert.organization_id) : null;

    const issued = cert.issued_at ?? cert.created_at;
    const expires = cert.expires_at;
    const status = cert.status ?? "—";

    const courseLabel = (c?.title ?? "").trim() || "Untitled course";

    const fullName = (u?.full_name ?? "").trim();
    const email = (u?.email ?? "").trim();
    const userLabel = fullName ? (email ? `${fullName} (${email})` : fullName) : (email || cert.user_id || "—");

    const orgLabel = (o?.name ?? "").trim() || (o?.slug ?? "").trim() || cert.organization_id || null;

    const canDownload = typeof cert.course_id === "string" && cert.course_id.length > 0;
    const downloadHref = canDownload ? `/api/courses/${cert.course_id}/certificate-template?download=1` : null;

    return {
      id: cert.id,
      userLabel,
      courseLabel,
      issuedLabel: issued ? new Date(issued).toLocaleDateString() : "—",
      statusLabel: status,
      expiresLabel: expires ? new Date(expires).toLocaleDateString() : null,
      organizationLabel: orgLabel,
      canDownload,
      downloadHref,
      meta: cert,
    };
  });

  return (
    <div className="space-y-6">
      {certError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Failed to load certificates: {certError.message}
        </div>
      ) : null}

      <CertificatesTableV2
        title="Certificates"
        subtitle="Manage all certificates across organizations"
        rows={rows}
      />
    </div>
  );
}


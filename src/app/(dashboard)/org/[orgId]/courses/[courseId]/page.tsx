import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";
import { CourseEnrollActions } from "@/features/courses/components/CourseEnrollActions";

type CourseRow = {
  id: string;
  title?: string | null;
  description?: string | null;
  excerpt?: string | null;
  cover_image_url?: string | null;
  created_at?: string | null;
  is_published?: boolean | null;
  organization_id?: string | null;
  visibility_scope?: "all" | "organizations" | null;
};

function pickCoverGradient(seed: string) {
  const gradients = [
    "bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500",
    "bg-gradient-to-br from-slate-700 via-slate-800 to-black",
    "bg-gradient-to-br from-rose-500 via-red-500 to-amber-500",
    "bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-500",
    "bg-gradient-to-br from-blue-500 via-sky-500 to-cyan-400",
    "bg-gradient-to-br from-violet-500 via-purple-500 to-pink-500",
    "bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500",
    "bg-gradient-to-br from-green-500 via-emerald-500 to-lime-400",
    "bg-gradient-to-br from-neutral-700 via-zinc-800 to-slate-900",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return gradients[hash % gradients.length];
}

export default async function OrgCourseDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; courseId: string }>;
}) {
  const { user, error } = await getServerUser();
  if (error || !user) redirect("/");

  const { orgId: orgKey, courseId } = await params;
  const resolved = await resolveOrgKey(orgKey);
  const org = resolved.org;
  if (!org) {
    if (user.role === "organization_admin" || user.role === "member") redirect("/unauthorized");
    notFound();
  }

  const orgId = org.id; // UUID (DB/API)
  const orgSlug = org.slug; // canonical slug (links)

  const supabase = await createServerSupabaseClient();
  const { data, error: courseError } = await supabase
    .from("courses")
    .select("id, title, description, excerpt, cover_image_url, created_at, is_published, organization_id, visibility_scope")
    .eq("id", courseId)
    .single();

  if (courseError || !data) {
    redirect(`/org/${orgSlug}/courses`);
  }

  const course = data as CourseRow;

  // Keep org route context: ensure the course is visible to this org.
  const isOrgOwned = course.organization_id === orgId;
  const isGlobal = course.visibility_scope === "all";
  let isAssigned = false;
  if (!isOrgOwned && !isGlobal) {
    const { data: link } = await supabase
      .from("course_organizations")
      .select("course_id")
      .eq("course_id", courseId)
      .eq("organization_id", orgId)
      .maybeSingle();
    isAssigned = Boolean(link);
  }

  if (!isOrgOwned && !isGlobal && !isAssigned) {
    redirect(`/org/${orgSlug}/courses`);
  }

  const title = course.title ?? "(untitled)";
  const canEdit =
    user.role === "organization_admin" &&
    user.organization_id === orgId &&
    course.organization_id === orgId;

  let isEnrolled = false;
  if (user.role === "member") {
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("id, status")
      .eq("course_id", courseId)
      .eq("user_id", user.id)
      .maybeSingle();
    isEnrolled = Boolean(enr?.id) && (enr as { status?: string | null }).status === "active";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <BookOpen className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{title}</h1>
            <p className="text-muted-foreground">
              {course.is_published ? "Published" : "Draft"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={`/org/${orgSlug}/courses`}>Back</Link>
          </Button>
          {canEdit ? (
            <Button asChild>
              <Link href={`/org/${orgSlug}/courses/${courseId}/edit`}>Edit</Link>
            </Button>
          ) : null}
          {user.role === "member" ? (
            <CourseEnrollActions
              orgId={orgSlug}
              courseId={courseId}
              isEnrolled={isEnrolled}
              disabled={course.is_published !== true}
            />
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className={`relative h-56 ${course.cover_image_url ? "" : pickCoverGradient(courseId)}`}>
          {course.cover_image_url ? (
            <Image
              src={course.cover_image_url}
              alt={`${title} cover`}
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 900px"
            />
          ) : null}
          <div className="absolute inset-0 bg-linear-to-t from-black/35 via-black/10 to-transparent" />
        </div>

        <div className="p-6 space-y-4">
          {course.excerpt ? (
            <p className="text-foreground font-medium">{course.excerpt}</p>
          ) : null}

          <div className="prose prose-sm max-w-none text-foreground">
            <p className="text-muted-foreground whitespace-pre-wrap">
              {course.description?.trim().length ? course.description : "No description yet."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


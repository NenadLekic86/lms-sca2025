import { notFound, redirect } from "next/navigation";
import { BookOpen } from "lucide-react";

import { createServerSupabaseClient, getServerUser } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { CourseLearnClient } from "@/features/courses/components/CourseLearnClient";
import { resolveOrgKey } from "@/lib/organizations/resolveOrgKey";

export const fetchCache = "force-no-store";

type CourseRow = {
  id: string;
  title: string | null;
  is_published: boolean | null;
};

type ResourceRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

type VideoRow = {
  id: string;
  original_url: string;
  embed_url: string | null;
  title: string | null;
  provider: string | null;
};

type ProgressRow = {
  item_type: "resource" | "video";
  item_id: string;
  completed_at: string | null;
};

export default async function CourseLearnPage({
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
  const orgSlug = org.slug;

  // This page is for members learning flow.
  if (user.role !== "member") {
    redirect(`/org/${orgSlug}/courses/${courseId}`);
  }

  const supabase = await createServerSupabaseClient();

  // Ensure enrolled (RLS allows member read own enrollment).
  const { data: enrollment } = await supabase
    .from("course_enrollments")
    .select("id, status")
    .eq("course_id", courseId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!enrollment?.id || enrollment.status !== "active") {
    redirect(`/org/${orgSlug}/courses/${courseId}`);
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("id, title, is_published")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    redirect(`/org/${orgSlug}/courses`);
  }

  if ((course as CourseRow).is_published !== true) {
    // Members can only learn published courses.
    redirect(`/org/${orgSlug}/courses/${courseId}`);
  }

  const [{ data: resources }, { data: videos }, { data: progress }] = await Promise.all([
    supabase
      .from("course_resources")
      .select("id, file_name, mime_type, size_bytes")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false }),
    supabase
      .from("course_videos")
      .select("id, original_url, embed_url, title, provider")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false }),
    supabase
      .from("course_content_progress")
      .select("item_type, item_id, completed_at")
      .eq("course_id", courseId)
      .eq("user_id", user.id),
  ]);

  const courseTitle = ((course as CourseRow).title ?? "").trim() || "(untitled)";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <BookOpen className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Course learning</h1>
            <p className="text-muted-foreground">{courseTitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={`/org/${orgSlug}/courses/${courseId}`}>Back</Link>
          </Button>
        </div>
      </div>

      <CourseLearnClient
        orgId={orgSlug}
        courseId={courseId}
        courseTitle={courseTitle}
        resources={(Array.isArray(resources) ? resources : []) as ResourceRow[]}
        videos={(Array.isArray(videos) ? videos : []) as VideoRow[]}
        initialProgress={(Array.isArray(progress) ? progress : []) as ProgressRow[]}
      />
    </div>
  );
}


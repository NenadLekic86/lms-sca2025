"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api";

export function CourseEnrollActions({
  orgId,
  courseId,
  isEnrolled,
  disabled,
}: {
  orgId: string;
  courseId: string;
  isEnrolled: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function enrollAndStart() {
    if (disabled) return;
    if (isEnrolled) {
      router.push(`/org/${orgId}/courses/${courseId}/learn`);
      return;
    }

    setLoading(true);
    try {
      const { message } = await fetchJson<{ enrollment: unknown }>(`/api/courses/${courseId}/enroll`, { method: "POST" });
      toast.success(message || "Enrollment started.");
      router.push(`/org/${orgId}/courses/${courseId}/learn`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to enroll");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={() => void enrollAndStart()} disabled={disabled || loading} className="gap-2">
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
      {isEnrolled ? "Continue learning" : "Start learning"}
    </Button>
  );
}


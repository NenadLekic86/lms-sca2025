import Image from "next/image";
import { Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function Step1CourseInfo({
  mode,
  title,
  setTitle,
  excerpt,
  setExcerpt,
  description,
  setDescription,
  coverImageUrl,
  coverFile,
  setCoverFile,
  isUploadingCover,
  isSavingCourse,
  onSaveCourseInfo,
  onUploadCover,
  hidePrimaryActions,
}: {
  mode: "create" | "edit";
  title: string;
  setTitle: (v: string) => void;
  excerpt: string;
  setExcerpt: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  coverImageUrl: string | null;
  coverFile: File | null;
  setCoverFile: (f: File | null) => void;
  isUploadingCover: boolean;
  isSavingCourse: boolean;
  onSaveCourseInfo: () => void;
  onUploadCover: () => void;
  hidePrimaryActions?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="title">Course Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter course title"
              maxLength={160}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="excerpt">Excerpt (optional)</Label>
            <Input
              id="excerpt"
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
              placeholder="Short summary (shows on cards)"
              maxLength={280}
            />
            <p className="text-xs text-muted-foreground">{excerpt.trim().length}/280</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Write a short description for the course…"
              maxLength={5000}
            />
            <p className="text-xs text-muted-foreground">{description.trim().length}/5000</p>
          </div>

          {!hidePrimaryActions ? (
            <div className="flex items-center gap-2">
              <Button onClick={onSaveCourseInfo} disabled={isSavingCourse || isUploadingCover}>
                {isSavingCourse ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {mode === "create" ? "Create draft" : "Save changes"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Step 1 content is visible on the public course page.
              </span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Step 1 content is visible on the public course page.
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="font-medium text-foreground">Featured Image (Cover)</div>

          {coverImageUrl ? (
            <div className="relative aspect-video overflow-hidden rounded-md border">
              <Image
                src={coverImageUrl}
                alt="Course cover"
                fill
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 520px"
              />
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 p-6 text-sm text-muted-foreground text-center">
              No image uploaded
            </div>
          )}

          {mode === "edit" ? (
            <div className="space-y-2">
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="secondary"
                onClick={onUploadCover}
                disabled={!coverFile || isUploadingCover || isSavingCourse}
              >
                {isUploadingCover ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload image
              </Button>
              <p className="text-xs text-muted-foreground">Max file size 5MB. Formats: PNG/JPG/WebP.</p>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Create the draft first, then upload the featured image.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


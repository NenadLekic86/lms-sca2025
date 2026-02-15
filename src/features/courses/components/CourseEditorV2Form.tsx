"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ExternalLink,
  GripVertical,
  Loader2,
  Pencil,
  Paperclip,
  Plus,
  Save,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { normalizeSlug } from "@/lib/courses/v2.shared";
import { RichTextEditorWithUploads } from "@/features/courses/components/v2/RichTextEditorWithUploads";
import { QuizWizardModal } from "@/features/courses/components/v2/QuizWizardModal";
import {
  extractInlineUploadIdsFromHtml,
  finalizeInlineImagesInHtml,
  pruneQueueByHtml,
  revokeInlineQueueObjectUrls,
  revokeObjectUrlSafe,
  type InlineImageQueue,
} from "@/lib/richtext/inlineImages";

export type MemberOption = {
  id: string;
  label: string;
};

export type CourseTopicItem = {
  id: string;
  item_type: "lesson" | "quiz";
  title: string | null;
  position: number;
  payload_json: Record<string, unknown>;
};

export type CourseTopic = {
  id: string;
  title: string;
  summary: string | null;
  position: number;
  items: CourseTopicItem[];
};

export type CourseV2 = {
  id: string;
  title: string | null;
  slug: string | null;
  status: "draft" | "published" | null;
  about_html: string | null;
  excerpt: string | null;
  difficulty_level: "all_levels" | "beginner" | "intermediate" | "expert" | null;
  what_will_learn: string | null;
  total_duration_hours: number | null;
  total_duration_minutes: number | null;
  materials_included: string | null;
  requirements_instructions: string | null;
  intro_video_provider: "html5" | "youtube" | "vimeo" | null;
  intro_video_url: string | null;
  intro_video_storage_path: string | null;
  cover_image_url: string | null;
  permalink?: string;
  assigned_member_ids?: string[];
};

type SaveResultCourse = {
  id: string;
  slug: string | null;
  status: "draft" | "published" | null;
};

type LessonVideoProvider = "html5" | "youtube" | "vimeo";

type LessonContentBlock = {
  id: string;
  html: string;
};

type LessonModalState = {
  itemType: "lesson";
  mode: "create" | "edit";
  topicId: string;
  itemId: string | null;
  lessonName: string;
  contentBlocks: LessonContentBlock[];
  inlineImages: InlineImageQueue;
  featureImageFile: File | null;
  featureImagePreviewUrl: string | null;
  featureImageStoragePath: string | null;
  videoProvider: LessonVideoProvider;
  videoUrl: string;
  videoFile: File | null;
  videoStoragePath: string | null;
  playbackHours: number;
  playbackMinutes: number;
  attachments: File[];
  existingAttachments: Array<{ file_name: string; storage_path: string; size_bytes?: number | null; mime?: string | null }>;
};

type QuizModalState = {
  itemType: "quiz";
  mode: "create" | "edit";
  topicId: string;
  itemId: string | null;
  title: string;
  summary: string;
  payload_json: Record<string, unknown> | null;
};

type ItemModalState = LessonModalState | QuizModalState;

type PendingLessonUploads = {
  featureImageFile: File | null;
  videoFile: File | null;
  attachments: File[];
  inlineImages: InlineImageQueue;
};

// We intentionally do NOT store visual separators (like <hr>) inside lesson HTML.
// Spacing is handled at render time. This keeps persisted content cleaner and safer.
const LESSON_BLOCK_SEPARATOR = "\n\n";

function joinLessonBlocksHtml(blocks: LessonContentBlock[]): string {
  const parts = blocks.map((b) => (b?.html ?? "").trim()).filter((v) => v.length > 0);
  return parts.join(LESSON_BLOCK_SEPARATOR);
}

function extractLessonBlocksFromPayload(payload: Record<string, unknown>): LessonContentBlock[] {
  const raw = (payload as { content_blocks?: unknown }).content_blocks;
  if (Array.isArray(raw)) {
    const blocks = raw
      .map((v) => (typeof v === "string" ? v : null))
      .filter((v): v is string => typeof v === "string")
      .map((html, idx) => ({ id: `blk_${idx}_${Date.now()}`, html }));
    if (blocks.length) return blocks;
  }

  const fallback = typeof (payload as { content_html?: unknown }).content_html === "string" ? String((payload as { content_html: string }).content_html) : "";
  // Backwards-compat: if older persisted HTML used <hr> separators, split into blocks.
  const parts = fallback
    .split(/<hr\b[^>]*>/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return parts.map((html, idx) => ({ id: `blk_${idx}_${Date.now()}`, html }));
  }
  return [{ id: `blk_0_${Date.now()}`, html: fallback }];
}

function deepClone<T>(value: T): T {
  // Prefer structuredClone when available (handles nested objects safely).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc = (globalThis as any)?.structuredClone as ((v: unknown) => unknown) | undefined;
  if (typeof sc === "function") return sc(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeTempId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }
}

function makeBlockId(): string {
  return makeTempId("blk");
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-muted-foreground">{children}</p>;
}

function DetailsSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-lg border bg-card shadow-sm [&_summary::-webkit-details-marker]:hidden" open={defaultOpen}>
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </div>
      </summary>
      <div className="border-t px-4 py-4">{children}</div>
    </details>
  );
}

function hasMeaningfulRichText(html: string): boolean {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 8;
}

function pruneQueueByHtmlWithRevoke(prevQueue: InlineImageQueue, html: string): InlineImageQueue {
  const prev = prevQueue ?? {};
  const next = pruneQueueByHtml(prev, html);
  for (const id of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(next, id)) continue;
    revokeObjectUrlSafe(prev[id]?.objectUrl);
  }
  return next;
}

function pruneQueueByBlocksWithRevoke(prevQueue: InlineImageQueue, blocks: LessonContentBlock[]): InlineImageQueue {
  return pruneQueueByHtmlWithRevoke(prevQueue, joinLessonBlocksHtml(blocks));
}

function SortableTopicRow({
  topic,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddLesson,
  onAddQuiz,
  onEditLessonItem,
  onEditQuizItem,
  onReorderItems,
  onDeleteItem,
}: {
  topic: CourseTopic;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddLesson: () => void;
  onAddQuiz: () => void;
  onEditLessonItem: (topicId: string, item: CourseTopicItem) => void;
  onEditQuizItem: (topicId: string, item: CourseTopicItem) => void;
  onReorderItems: (topicId: string, orderedItemIds: string[]) => void;
  onDeleteItem: (topicId: string, itemId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topic.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("rounded-md border bg-muted/10", isDragging && "opacity-70 shadow-md")}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3 border-b bg-muted/10">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
            aria-label="Move topic"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{topic.title}</p>
            {topic.summary ? <p className="text-xs text-muted-foreground truncate">{topic.summary}</p> : null}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} title="Edit topic">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onDelete} title="Delete topic">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onToggle} title={expanded ? "Collapse topic" : "Expand topic"}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="px-3 py-3 space-y-3">
          {topic.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">No content items yet for this topic.</p>
          ) : (
            <div className="space-y-2">
              <DndContext
                collisionDetection={closestCenter}
                onDragEnd={(event) => {
                  const { active, over } = event;
                  if (!over || active.id === over.id) return;
                  const ordered = topic.items
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map((i) => i.id);
                  const oldIndex = ordered.findIndex((id) => id === active.id);
                  const newIndex = ordered.findIndex((id) => id === over.id);
                  if (oldIndex < 0 || newIndex < 0) return;
                  const next = ordered.slice();
                  const [moved] = next.splice(oldIndex, 1);
                  next.splice(newIndex, 0, moved);
                  onReorderItems(topic.id, next);
                }}
              >
                <SortableContext
                  items={topic.items
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {topic.items
                      .slice()
                      .sort((a, b) => a.position - b.position)
                      .map((item) => (
                        <SortableTopicItemRow
                          key={item.id}
                          topicId={topic.id}
                          item={item}
                          onEditLessonItem={onEditLessonItem}
                          onEditQuizItem={onEditQuizItem}
                          onDeleteItem={onDeleteItem}
                        />
                      ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onAddLesson}>
              <Plus className="h-4 w-4" />
              Lesson
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onAddQuiz}>
              <Plus className="h-4 w-4" />
              Quiz
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SortableTopicItemRow({
  topicId,
  item,
  onEditLessonItem,
  onEditQuizItem,
  onDeleteItem,
}: {
  topicId: string;
  item: CourseTopicItem;
  onEditLessonItem: (topicId: string, item: CourseTopicItem) => void;
  onEditQuizItem: (topicId: string, item: CourseTopicItem) => void;
  onDeleteItem: (topicId: string, itemId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex items-center justify-between rounded-md border bg-background px-3 py-2", isDragging && "opacity-70 shadow-md")}
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
          aria-label="Move item"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <p className="text-sm font-medium truncate">{item.title?.trim() || "(untitled)"}</p>
        <p className="text-xs text-muted-foreground uppercase ml-2">{item.item_type}</p>
      </div>
      <div className="flex items-center gap-1">
        {item.item_type === "lesson" ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onEditLessonItem(topicId, item)} title="Edit lesson">
            <Pencil className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onEditQuizItem(topicId, item)} title="Edit quiz">
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onDeleteItem(topicId, item.id)} title="Delete item">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function SortableLessonContentBlockRow({
  block,
  index,
  onChangeHtml,
  onRemove,
  queue,
  setQueue,
}: {
  block: LessonContentBlock;
  index: number;
  onChangeHtml: (nextHtml: string) => void;
  onRemove: () => void;
  queue: InlineImageQueue;
  setQueue: (next: InlineImageQueue | ((prev: InlineImageQueue) => InlineImageQueue)) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-lg border bg-background shadow-sm overflow-hidden",
        isDragging ? "opacity-70" : ""
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted/40 text-muted-foreground cursor-grab active:cursor-grabbing"
            title="Drag to reorder"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="text-xs font-semibold text-muted-foreground truncate">Content block {index + 1}</div>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onRemove} title="Remove content block" aria-label="Remove content block">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="p-3">
        <RichTextEditorWithUploads
          value={block.html}
          onChange={onChangeHtml}
          placeholder="Write lesson content here..."
          minHeightClass="min-h-[220px]"
          queue={queue}
          setQueue={setQueue}
        />
      </div>
    </div>
  );
}

function StaticTopicRow({
  topic,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddLesson,
  onAddQuiz,
  onEditLessonItem,
  onEditQuizItem,
  onDeleteItem,
}: {
  topic: CourseTopic;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddLesson: () => void;
  onAddQuiz: () => void;
  onEditLessonItem: (topicId: string, item: CourseTopicItem) => void;
  onEditQuizItem: (topicId: string, item: CourseTopicItem) => void;
  onDeleteItem: (topicId: string, itemId: string) => void;
}) {
  return (
    <div className="rounded-md border bg-muted/10">
      <div className="flex items-center justify-between gap-2 px-3 py-3 border-b bg-muted/10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground" aria-hidden="true">
            <GripVertical className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{topic.title}</p>
            {topic.summary ? <p className="text-xs text-muted-foreground truncate">{topic.summary}</p> : null}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} title="Edit topic">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onDelete} title="Delete topic">
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onToggle} title={expanded ? "Collapse topic" : "Expand topic"}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="px-3 py-3 space-y-3">
          {topic.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">No content items yet for this topic.</p>
          ) : (
            <div className="space-y-2">
              {topic.items
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm font-medium truncate">{item.title?.trim() || "(untitled)"}</p>
                      <p className="text-xs text-muted-foreground uppercase ml-2">{item.item_type}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {item.item_type === "lesson" ? (
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onEditLessonItem(topic.id, item)} title="Edit lesson">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onEditQuizItem(topic.id, item)} title="Edit quiz">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => onDeleteItem(topic.id, item.id)} title="Delete item">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onAddLesson}>
              <Plus className="h-4 w-4" />
              Lesson
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onAddQuiz}>
              <Plus className="h-4 w-4" />
              Quiz
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function CourseEditorV2Form({
  mode,
  orgSlug,
  backHref,
  initialCourse,
  initialTopics,
  memberOptions,
}: {
  mode: "create" | "edit";
  orgSlug: string;
  backHref: string;
  initialCourse: CourseV2 | null;
  initialTopics: CourseTopic[];
  memberOptions: MemberOption[];
}) {
  const router = useRouter();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [courseId, setCourseId] = useState<string | null>(initialCourse?.id ?? null);
  const [status, setStatus] = useState<"draft" | "published">(initialCourse?.status === "published" ? "published" : "draft");
  const [needsRepublish, setNeedsRepublish] = useState(false);
  const [pendingDeletedTopicIds, setPendingDeletedTopicIds] = useState<string[]>([]);
  const [pendingDeletedItemIds, setPendingDeletedItemIds] = useState<string[]>([]);
  const [pendingLessonUploadsByItemId, setPendingLessonUploadsByItemId] = useState<Record<string, PendingLessonUploads>>({});
  const [leavePrompt, setLeavePrompt] = useState<{ href: string } | null>(null);
  const [confirmUnpublishDraftOpen, setConfirmUnpublishDraftOpen] = useState(false);
  const [title, setTitle] = useState(initialCourse?.title ?? "");
  const [slug, setSlug] = useState(initialCourse?.slug ?? "");
  const [isSlugManuallyEdited, setIsSlugManuallyEdited] = useState(Boolean(initialCourse?.slug?.trim()));
  const [aboutHtml, setAboutHtml] = useState(initialCourse?.about_html ?? "");
  const [pendingCourseAboutInlineImages, setPendingCourseAboutInlineImages] = useState<InlineImageQueue>({});
  const [excerpt, setExcerpt] = useState(initialCourse?.excerpt ?? "");
  const [difficulty, setDifficulty] = useState<CourseV2["difficulty_level"]>(initialCourse?.difficulty_level ?? "all_levels");
  const [whatWillLearn, setWhatWillLearn] = useState(initialCourse?.what_will_learn ?? "");
  const [hours, setHours] = useState<number>(initialCourse?.total_duration_hours ?? 0);
  const [minutes, setMinutes] = useState<number>(initialCourse?.total_duration_minutes ?? 0);
  const [materialsIncluded, setMaterialsIncluded] = useState(initialCourse?.materials_included ?? "");
  const [requirements, setRequirements] = useState(initialCourse?.requirements_instructions ?? "");
  const [videoProvider, setVideoProvider] = useState<"html5" | "youtube" | "vimeo">(initialCourse?.intro_video_provider ?? "html5");
  const [videoUrl, setVideoUrl] = useState(initialCourse?.intro_video_url ?? "");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isVideoDragActive, setIsVideoDragActive] = useState(false);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState(initialCourse?.cover_image_url ?? "");
  const [thumbnailObjectUrl, setThumbnailObjectUrl] = useState<string | null>(null);
  const [isThumbnailDragActive, setIsThumbnailDragActive] = useState(false);
  const [pendingThumbnailRemoval, setPendingThumbnailRemoval] = useState(false);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set(initialCourse?.assigned_member_ids ?? []));
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");

  const [topics, setTopics] = useState<CourseTopic[]>(initialTopics ?? []);
  const [expandedTopicIds, setExpandedTopicIds] = useState<Set<string>>(new Set());

  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successModal, setSuccessModal] = useState<{ title: string; description: string } | null>(null);
  const [origin, setOrigin] = useState("");
  const [dndReady, setDndReady] = useState(false);

  const [topicModal, setTopicModal] = useState<{ mode: "create" | "edit"; topicId: string | null; title: string; summary: string } | null>(null);
  const [itemModal, setItemModal] = useState<ItemModalState | null>(null);
  const itemModalType = itemModal?.itemType ?? null;
  const lessonFeatureImageFile = itemModalType === "lesson" ? (itemModal as LessonModalState).featureImageFile : null;

  function ensureAtLeastOneBlock(blocks: LessonContentBlock[]): LessonContentBlock[] {
    if (blocks.length > 0) return blocks;
    return [{ id: makeBlockId(), html: "" }];
  }

  function reorderBlocks(blocks: LessonContentBlock[], activeId: string, overId: string): LessonContentBlock[] {
    const oldIndex = blocks.findIndex((b) => b.id === activeId);
    const newIndex = blocks.findIndex((b) => b.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return blocks;
    const next = blocks.slice();
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    return next;
  }

  function addLessonContentBlock() {
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return prev;
      const nextBlocks = [...(prev.contentBlocks ?? []), { id: makeBlockId(), html: "" }];
      return { ...prev, contentBlocks: nextBlocks };
    });
    if (status === "published") setNeedsRepublish(true);
  }

  function removeLessonContentBlock(blockId: string) {
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return prev;
      const nextBlocks = ensureAtLeastOneBlock((prev.contentBlocks ?? []).filter((b) => b.id !== blockId));
      const nextInline = pruneQueueByBlocksWithRevoke(prev.inlineImages ?? {}, nextBlocks);
      return { ...prev, contentBlocks: nextBlocks, inlineImages: nextInline };
    });
    if (status === "published") setNeedsRepublish(true);
  }

  function onLessonBlocksDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return prev;
      const blocks = prev.contentBlocks ?? [];
      const nextBlocks = reorderBlocks(blocks, String(active.id), String(over.id));
      return { ...prev, contentBlocks: nextBlocks };
    });
    if (status === "published") setNeedsRepublish(true);
  }

  const savedSnapshotRef = useRef<{
    courseId: string | null;
    status: "draft" | "published";
    title: string;
    slug: string;
    isSlugManuallyEdited: boolean;
    aboutHtml: string;
    excerpt: string;
    difficulty: CourseV2["difficulty_level"];
    whatWillLearn: string;
    hours: number;
    minutes: number;
    materialsIncluded: string;
    requirements: string;
    videoProvider: "html5" | "youtube" | "vimeo";
    videoUrl: string;
    thumbnailUrl: string;
    selectedMemberIds: string[];
    topics: CourseTopic[];
  }>({
    courseId: initialCourse?.id ?? null,
    status: initialCourse?.status === "published" ? "published" : "draft",
    title: initialCourse?.title ?? "",
    slug: initialCourse?.slug ?? "",
    isSlugManuallyEdited: Boolean(initialCourse?.slug?.trim()),
    aboutHtml: initialCourse?.about_html ?? "",
    excerpt: initialCourse?.excerpt ?? "",
    difficulty: initialCourse?.difficulty_level ?? "all_levels",
    whatWillLearn: initialCourse?.what_will_learn ?? "",
    hours: initialCourse?.total_duration_hours ?? 0,
    minutes: initialCourse?.total_duration_minutes ?? 0,
    materialsIncluded: initialCourse?.materials_included ?? "",
    requirements: initialCourse?.requirements_instructions ?? "",
    videoProvider: (initialCourse?.intro_video_provider ?? "html5") as "html5" | "youtube" | "vimeo",
    videoUrl: initialCourse?.intro_video_url ?? "",
    thumbnailUrl: initialCourse?.cover_image_url ?? "",
    selectedMemberIds: initialCourse?.assigned_member_ids ?? [],
    topics: deepClone(initialTopics ?? []),
  });

  const currentSignature = useMemo(() => {
    const members = [...selectedMemberIds].sort();
    const topicsSig = topics.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary ?? null,
      position: t.position,
      items: (t.items ?? []).map((it) => ({
        id: it.id,
        item_type: it.item_type,
        title: it.title ?? null,
        position: it.position,
        payload_json: it.payload_json ?? {},
      })),
    }));

    const uploadSig = Object.entries(pendingLessonUploadsByItemId).map(([k, v]) => ({
      k,
      hasFeature: Boolean(v.featureImageFile),
      hasVideo: Boolean(v.videoFile),
      attachmentsCount: v.attachments?.length ?? 0,
      inlineImagesCount: Object.keys(v.inlineImages ?? {}).length,
    }));

    return JSON.stringify({
      courseId,
      status,
      title,
      slug,
      isSlugManuallyEdited,
      aboutHtml,
      excerpt,
      difficulty,
      whatWillLearn,
      hours,
      minutes,
      materialsIncluded,
      requirements,
      videoProvider,
      videoUrl,
      thumbnailUrl,
      members,
      topicsSig,
      pendingDeletedTopicIds: pendingDeletedTopicIds.slice().sort(),
      pendingDeletedItemIds: pendingDeletedItemIds.slice().sort(),
      uploadSig: uploadSig.sort((a, b) => a.k.localeCompare(b.k)),
      hasIntroVideoFile: Boolean(videoFile),
      hasThumbnailFile: Boolean(thumbnailFile),
    });
  }, [
    aboutHtml,
    courseId,
    difficulty,
    excerpt,
    hours,
    isSlugManuallyEdited,
    materialsIncluded,
    minutes,
    pendingDeletedItemIds,
    pendingDeletedTopicIds,
    pendingLessonUploadsByItemId,
    requirements,
    selectedMemberIds,
    slug,
    status,
    thumbnailFile,
    thumbnailUrl,
    title,
    topics,
    videoFile,
    videoProvider,
    videoUrl,
    whatWillLearn,
  ]);

  const savedSignatureRef = useRef<string>("");
  useEffect(() => {
    if (savedSignatureRef.current) return;
    const snap = savedSnapshotRef.current;
    savedSignatureRef.current = JSON.stringify({
      courseId: snap.courseId,
      status: snap.status,
      title: snap.title,
      slug: snap.slug,
      isSlugManuallyEdited: snap.isSlugManuallyEdited,
      aboutHtml: snap.aboutHtml,
      excerpt: snap.excerpt,
      difficulty: snap.difficulty,
      whatWillLearn: snap.whatWillLearn,
      hours: snap.hours,
      minutes: snap.minutes,
      materialsIncluded: snap.materialsIncluded,
      requirements: snap.requirements,
      videoProvider: snap.videoProvider,
      videoUrl: snap.videoUrl,
      thumbnailUrl: snap.thumbnailUrl,
      members: (snap.selectedMemberIds ?? []).slice().sort(),
      topicsSig: (snap.topics ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        summary: t.summary ?? null,
        position: t.position,
        items: (t.items ?? []).map((it) => ({
          id: it.id,
          item_type: it.item_type,
          title: it.title ?? null,
          position: it.position,
          payload_json: it.payload_json ?? {},
        })),
      })),
      pendingDeletedTopicIds: [],
      pendingDeletedItemIds: [],
      uploadSig: [],
      hasIntroVideoFile: false,
      hasThumbnailFile: false,
    });
  }, []);

  const hasUnsavedChanges = currentSignature !== savedSignatureRef.current;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setDndReady(true);
  }, []);

  useEffect(() => {
    if (status !== "published") setNeedsRepublish(false);
  }, [status]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChanges) return;
      e.preventDefault();
      // Required for Chrome: setting returnValue triggers the native confirm dialog.
      e.returnValue = "";
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    // Any unsaved changes on a published course require republish to be visible to members.
    if (status !== "published") return;
    if (hasUnsavedChanges) setNeedsRepublish(true);
  }, [hasUnsavedChanges, status]);

  useEffect(() => {
    function onDocumentClickCapture(e: MouseEvent) {
      if (!hasUnsavedChanges) return;
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest("[data-leave-guard-ignore='true']")) return;
      const a = target.closest("a") as HTMLAnchorElement | null;
      if (!a) return;
      if (a.target && a.target.toLowerCase() === "_blank") return;
      if (a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;

      e.preventDefault();
      e.stopPropagation();
      setLeavePrompt({ href: `${url.pathname}${url.search}${url.hash}` });
    }

    document.addEventListener("click", onDocumentClickCapture, true);
    return () => document.removeEventListener("click", onDocumentClickCapture, true);
  }, [hasUnsavedChanges]);

  function discardAllChanges() {
    const snap = savedSnapshotRef.current;
    for (const v of Object.values(pendingLessonUploadsByItemId ?? {})) {
      revokeInlineQueueObjectUrls(v?.inlineImages ?? {});
    }
    revokeInlineQueueObjectUrls(pendingCourseAboutInlineImages ?? {});
    setCourseId(snap.courseId);
    setStatus(snap.status);
    setNeedsRepublish(false);
    setTitle(snap.title);
    setSlug(snap.slug);
    setIsSlugManuallyEdited(snap.isSlugManuallyEdited);
    setAboutHtml(snap.aboutHtml);
    setPendingCourseAboutInlineImages({});
    setExcerpt(snap.excerpt);
    setDifficulty(snap.difficulty ?? "all_levels");
    setWhatWillLearn(snap.whatWillLearn);
    setHours(snap.hours ?? 0);
    setMinutes(snap.minutes ?? 0);
    setMaterialsIncluded(snap.materialsIncluded);
    setRequirements(snap.requirements);
    setVideoProvider(snap.videoProvider);
    setVideoUrl(snap.videoUrl);
    setVideoFile(null);
    setThumbnailUrl(snap.thumbnailUrl);
    setThumbnailFile(null);
    setPendingThumbnailRemoval(false);
    setSelectedMemberIds(new Set(snap.selectedMemberIds ?? []));
    setTopics(deepClone(snap.topics ?? []));
    setPendingDeletedItemIds([]);
    setPendingDeletedTopicIds([]);
    setPendingLessonUploadsByItemId({});
    setTopicModal(null);
    setItemModal(null);
    setError(null);
  }

  useEffect(() => {
    if (!thumbnailFile) {
      setThumbnailObjectUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(thumbnailFile);
    setThumbnailObjectUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [thumbnailFile]);

  useEffect(() => {
    if (itemModalType !== "lesson") return;
    if (!lessonFeatureImageFile) {
      setItemModal((prev) => {
        if (!prev || prev.itemType !== "lesson") return prev;
        if (prev.featureImagePreviewUrl === null) return prev;
        return { ...prev, featureImagePreviewUrl: null };
      });
      return;
    }
    const u = URL.createObjectURL(lessonFeatureImageFile);
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return prev;
      return { ...prev, featureImagePreviewUrl: u };
    });
    return () => URL.revokeObjectURL(u);
  }, [itemModalType, lessonFeatureImageFile]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return memberOptions;
    return memberOptions.filter((m) => m.label.toLowerCase().includes(q));
  }, [memberOptions, memberSearch]);

  const allFilteredSelected = filteredMembers.length > 0 && filteredMembers.every((m) => selectedMemberIds.has(m.id));

  const permalink = useMemo(() => {
    const usableSlug = (slug || normalizeSlug(title || "course")).trim();
    if (!usableSlug) return "";
    return `${origin}/org/${encodeURIComponent(orgSlug)}/courses/${encodeURIComponent(usableSlug)}`;
  }, [origin, orgSlug, slug, title]);

  const canPublish = topics.length > 0 && title.trim().length >= 2 && hasMeaningfulRichText(aboutHtml);
  const previewHref = courseId ? `/org/${orgSlug}/courses/${encodeURIComponent((slug || "").trim() || courseId)}` : null;
  const canPreview = Boolean(previewHref) && !hasUnsavedChanges && !isBusy;

  const reorderItemsLocally = (topicId: string, orderedItemIds: string[]) => {
    setTopics((prev) =>
      prev.map((t) => {
        if (t.id !== topicId) return t;
        const byId = new Map(t.items.map((i) => [i.id, i]));
        const nextItems: CourseTopicItem[] = [];
        for (const id of orderedItemIds) {
          const it = byId.get(id);
          if (it) nextItems.push(it);
        }
        // Keep any items not included (safety).
        for (const it of t.items) {
          if (!orderedItemIds.includes(it.id)) nextItems.push(it);
        }
        return { ...t, items: nextItems.map((it, idx) => ({ ...it, position: idx })) };
      })
    );
    if (status === "published") setNeedsRepublish(true);
  };

  const setTopicExpanded = (id: string, expanded: boolean) => {
    setExpandedTopicIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  async function ensureCourseDraftExists(): Promise<string> {
    if (courseId) return courseId;
    if (title.trim().length < 2) throw new Error("Course name must be at least 2 characters.");

    const { data } = await fetchJson<{ course: { id: string; slug: string; status: "draft" | "published" } }>("/api/v2/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
    const created = data.course;
    setCourseId(created.id);
    setSlug(created.slug);
    setStatus("draft");
    return created.id;
  }

  async function finalizeCourseAboutInlineImages(courseIdToUse: string): Promise<string> {
    const pruned = pruneQueueByHtml(pendingCourseAboutInlineImages ?? {}, aboutHtml ?? "");
    if (!Object.keys(pruned ?? {}).length) return aboutHtml;
    if (!aboutHtml || !aboutHtml.trim()) return aboutHtml;

    const { html: nextHtml, uploadedIds } = await finalizeInlineImagesInHtml({
      html: aboutHtml,
      queue: pruned,
      upload: async ({ uploadId, file }) => {
        const form = new FormData();
        form.append("file", file);
        form.append("upload_id", uploadId);
        const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/courses/${courseIdToUse}/inline-images`, { method: "POST", body: form });
        return { storage_path: String(data?.storage_path ?? "") };
      },
      stableSrcForStoragePath: (storagePath) => `/api/v2/course-assets?path=${encodeURIComponent(storagePath)}`,
    });

    setPendingCourseAboutInlineImages(() => {
      const next: InlineImageQueue = { ...pruned };
      for (const id of uploadedIds) delete next[id];
      return next;
    });
    setAboutHtml(nextHtml);
    return nextHtml;
  }

  async function saveCore(courseIdToUse: string, opts?: { aboutHtmlOverride?: string }): Promise<SaveResultCourse> {
    const payload = {
      title: title.trim(),
      slug: slug.trim() || undefined,
      about_html: (opts?.aboutHtmlOverride ?? aboutHtml),
      excerpt: excerpt.trim(),
      difficulty_level: difficulty ?? "all_levels",
      what_will_learn: whatWillLearn,
      total_duration_hours: Number.isFinite(hours) ? hours : 0,
      total_duration_minutes: Number.isFinite(minutes) ? minutes : 0,
      materials_included: materialsIncluded,
      requirements_instructions: requirements,
      intro_video_provider: videoProvider,
      intro_video_url: videoProvider === "html5" ? null : videoUrl.trim(),
    };

    const { data } = await fetchJson<{ course: SaveResultCourse }>(`/api/v2/courses/${courseIdToUse}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return data.course;
  }

  async function saveMembers(courseIdToUse: string) {
    await fetchJson<{ member_ids: string[] }>(`/api/v2/courses/${courseIdToUse}/members`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_ids: [...selectedMemberIds] }),
    });
  }

  function isTempId(id: string): boolean {
    return id.startsWith("tmp_");
  }

  async function syncCurriculumToServer(courseIdToUse: string): Promise<CourseTopic[]> {
    // This applies ALL local Course Builder changes (create/edit/reorder/delete + lesson assets)
    // in one explicit Save Draft / Publish / Republish action.
    const topicIdMap = new Map<string, string>();
    const itemIdMap = new Map<string, string>();

    // 1) Create/update topics (capture new IDs for temp topics).
    for (const topic of topics) {
      if (isTempId(topic.id)) {
        const { data } = await fetchJson<{ topic: { id: string; title: string; summary: string | null; position: number } }>(
          `/api/v2/courses/${courseIdToUse}/topics`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: topic.title, summary: topic.summary ?? "" }),
          }
        );
        topicIdMap.set(topic.id, data.topic.id);
      } else {
        await fetchJson(`/api/v2/topics/${topic.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: topic.title, summary: topic.summary ?? "" }),
        });
      }
    }

    // 2) Apply topic ordering.
    const resolvedOrderedTopicIds = topics.map((t) => topicIdMap.get(t.id) ?? t.id).filter((id) => !isTempId(id));
    if (resolvedOrderedTopicIds.length) {
      await fetchJson(`/api/v2/courses/${courseIdToUse}/topics/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordered_topic_ids: resolvedOrderedTopicIds }),
      });
    }

    // 3) Create/update items + upload lesson assets + reorder items per topic.
    const nextTopics: CourseTopic[] = [];
    for (const topic of topics) {
      const resolvedTopicId = topicIdMap.get(topic.id) ?? topic.id;
      const nextItems: CourseTopicItem[] = [];

      for (const item of topic.items ?? []) {
        // Skip items that were deleted locally.
        if (pendingDeletedItemIds.includes(item.id)) continue;

        let resolvedItemId = itemIdMap.get(item.id) ?? item.id;
        let savedItem: CourseTopicItem;

        if (isTempId(item.id)) {
          const { data } = await fetchJson<{ item: CourseTopicItem }>(`/api/v2/topics/${resolvedTopicId}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              item_type: item.item_type,
              title: item.title ?? "",
              payload_json: item.payload_json ?? {},
            }),
          });
          savedItem = data.item;
          resolvedItemId = savedItem.id;
          itemIdMap.set(item.id, savedItem.id);
        } else {
          const { data } = await fetchJson<{ item: CourseTopicItem }>(`/api/v2/items/${resolvedItemId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: item.title ?? "",
              payload_json: item.payload_json ?? {},
            }),
          });
          savedItem = data.item;
        }

        // If this is a lesson, upload pending assets (if any), then patch payload_json with storage paths.
        const pendingUploads = pendingLessonUploadsByItemId[item.id] ?? pendingLessonUploadsByItemId[resolvedItemId] ?? null;
        if (savedItem.item_type === "lesson" && pendingUploads) {
          const p = (savedItem.payload_json ?? {}) as Record<string, unknown>;
          const basePayload: Record<string, unknown> = { ...p };

          let featureImageStoragePath: string | null =
            typeof (p.feature_image as { storage_path?: unknown } | null)?.storage_path === "string"
              ? String((p.feature_image as { storage_path: string }).storage_path)
              : null;

          if (pendingUploads.featureImageFile) {
            const form = new FormData();
            form.append("file", pendingUploads.featureImageFile);
            const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/items/${resolvedItemId}/lesson/feature-image`, { method: "POST", body: form });
            featureImageStoragePath = data.storage_path;
          }

          let videoStoragePath: string | null =
            typeof (p.video as { storage_path?: unknown } | null)?.storage_path === "string"
              ? String((p.video as { storage_path: string }).storage_path)
              : null;

          const video = (p.video ?? {}) as { provider?: unknown };
          const provider = video?.provider === "youtube" || video?.provider === "vimeo" ? (video.provider as string) : "html5";
          if (provider === "html5" && pendingUploads.videoFile) {
            const form = new FormData();
            form.append("file", pendingUploads.videoFile);
            const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/items/${resolvedItemId}/lesson/video`, { method: "POST", body: form });
            videoStoragePath = data.storage_path;
          }

          let uploadedAttachments = Array.isArray((p as { attachments?: unknown }).attachments) ? ((p as { attachments: unknown[] }).attachments as unknown[]) : [];
          if (pendingUploads.attachments?.length) {
            const form = new FormData();
            for (const f of pendingUploads.attachments) form.append("files", f);
            const { data } = await fetchJson<{ attachments: LessonModalState["existingAttachments"] }>(`/api/v2/items/${resolvedItemId}/lesson/attachments`, {
              method: "POST",
              body: form,
            });
            uploadedAttachments = [...uploadedAttachments, ...(data.attachments ?? [])];
          }

          // Upload inline images referenced inside lesson HTML blocks, then rewrite <img src> to a stable app URL.
          // This keeps the "no auto-save" rule: we only upload + persist on explicit Save Draft / Publish / Republish.
          const rawBlocks = Array.isArray((basePayload as { content_blocks?: unknown }).content_blocks)
            ? ((basePayload as { content_blocks: unknown[] }).content_blocks as unknown[])
            : null;

          let contentBlocks: string[] = [];
          if (rawBlocks && rawBlocks.length) {
            contentBlocks = rawBlocks.map((v) => (typeof v === "string" ? v : "")).filter((v) => typeof v === "string");
          } else {
            const fallbackHtml = typeof (basePayload as { content_html?: unknown }).content_html === "string" ? String((basePayload as { content_html: string }).content_html) : "";
            contentBlocks = [fallbackHtml];
          }

          const joinedBefore = contentBlocks.join(LESSON_BLOCK_SEPARATOR);
          const workingQueue = pruneQueueByHtml(pendingUploads.inlineImages ?? {}, joinedBefore);

          if (Object.keys(workingQueue).length) {
            const rewrittenBlocks: string[] = [];
            for (const blockHtml of contentBlocks) {
              const blockQueue = pruneQueueByHtml(workingQueue, blockHtml);
              if (blockHtml && Object.keys(blockQueue).length) {
                const res = await finalizeInlineImagesInHtml({
                  html: blockHtml,
                  queue: blockQueue,
                  upload: async ({ uploadId, file }) => {
                    const form = new FormData();
                    form.append("file", file);
                    form.append("upload_id", uploadId);
                    const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/items/${resolvedItemId}/lesson/inline-images`, { method: "POST", body: form });
                    return { storage_path: String(data?.storage_path ?? "") };
                  },
                  stableSrcForStoragePath: (storagePath) => `/api/v2/lesson-assets?path=${encodeURIComponent(storagePath)}`,
                });
                rewrittenBlocks.push(res.html);
                for (const id of res.uploadedIds) {
                  delete workingQueue[id];
                }
              } else {
                rewrittenBlocks.push(blockHtml);
              }
            }
            contentBlocks = rewrittenBlocks;
          }

          const contentHtml = contentBlocks.map((h) => (h ?? "").trim()).filter((v) => v.length > 0).join(LESSON_BLOCK_SEPARATOR);

          const finalPayload: Record<string, unknown> = {
            ...basePayload,
            content_blocks: contentBlocks,
            content_html: contentHtml,
            feature_image: featureImageStoragePath ? { storage_path: featureImageStoragePath } : null,
            video:
              provider === "html5"
                ? videoStoragePath
                  ? { ...(typeof p.video === "object" && p.video ? (p.video as Record<string, unknown>) : {}), provider: "html5", storage_path: videoStoragePath }
                  : { ...(typeof p.video === "object" && p.video ? (p.video as Record<string, unknown>) : {}), provider: "html5" }
                : p.video,
            attachments: uploadedAttachments,
          };

          const { data: patched } = await fetchJson<{ item: CourseTopicItem }>(`/api/v2/items/${resolvedItemId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: savedItem.title ?? "", payload_json: finalPayload }),
          });
          savedItem = patched.item;
        }

        // If this is a quiz, upload any queued inline images referenced inside question HTML, then patch payload_json.
        if (savedItem.item_type === "quiz" && pendingUploads && Object.keys(pendingUploads.inlineImages ?? {}).length) {
          const base = (savedItem.payload_json ?? {}) as Record<string, unknown>;
          const workingQueue: InlineImageQueue = { ...(pendingUploads.inlineImages ?? {}) };
          const rawQuestions = Array.isArray((base as { questions?: unknown }).questions) ? ((base as { questions: unknown[] }).questions as unknown[]) : [];

          const nextQuestions = [];
          for (const q of rawQuestions) {
            if (!q || typeof q !== "object") {
              nextQuestions.push(q);
              continue;
            }
            const qq = q as Record<string, unknown>;
            let desc = typeof qq.description_html === "string" ? (qq.description_html as string) : "";
            let expl = typeof qq.answer_explanation_html === "string" ? (qq.answer_explanation_html as string) : "";
            if (desc && Object.keys(workingQueue).length) {
              const res = await finalizeInlineImagesInHtml({
                html: desc,
                queue: workingQueue,
                upload: async ({ uploadId, file }) => {
                  const form = new FormData();
                  form.append("file", file);
                  form.append("upload_id", uploadId);
                  const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/items/${resolvedItemId}/lesson/inline-images`, { method: "POST", body: form });
                  return { storage_path: String(data?.storage_path ?? "") };
                },
                stableSrcForStoragePath: (storagePath) => `/api/v2/lesson-assets?path=${encodeURIComponent(storagePath)}`,
              });
              desc = res.html;
              for (const id of res.uploadedIds) delete workingQueue[id];
            }
            if (expl && Object.keys(workingQueue).length) {
              const res = await finalizeInlineImagesInHtml({
                html: expl,
                queue: workingQueue,
                upload: async ({ uploadId, file }) => {
                  const form = new FormData();
                  form.append("file", file);
                  form.append("upload_id", uploadId);
                  const { data } = await fetchJson<{ storage_path: string }>(`/api/v2/items/${resolvedItemId}/lesson/inline-images`, { method: "POST", body: form });
                  return { storage_path: String(data?.storage_path ?? "") };
                },
                stableSrcForStoragePath: (storagePath) => `/api/v2/lesson-assets?path=${encodeURIComponent(storagePath)}`,
              });
              expl = res.html;
              for (const id of res.uploadedIds) delete workingQueue[id];
            }

            nextQuestions.push({ ...qq, description_html: desc, answer_explanation_html: expl });
          }

          const nextPayload: Record<string, unknown> = { ...base, questions: nextQuestions };
          const { data: patched } = await fetchJson<{ item: CourseTopicItem }>(`/api/v2/items/${resolvedItemId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: savedItem.title ?? "", payload_json: nextPayload }),
          });
          savedItem = patched.item;
        }

        nextItems.push(savedItem);
      }

      const orderedItemIds = nextItems.map((i) => i.id);
      if (orderedItemIds.length) {
        await fetchJson(`/api/v2/topics/${resolvedTopicId}/items/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ordered_item_ids: orderedItemIds }),
        });
      }

      nextTopics.push({
        ...topic,
        id: resolvedTopicId,
        items: nextItems.map((it, idx) => ({ ...it, position: idx })),
      });
    }

    // 4) Apply buffered deletions (existing IDs only).
    for (const itemId of pendingDeletedItemIds) {
      if (isTempId(itemId)) continue;
      await fetchJson(`/api/v2/items/${itemId}`, { method: "DELETE" });
    }
    for (const topicId of pendingDeletedTopicIds) {
      if (isTempId(topicId)) continue;
      await fetchJson(`/api/v2/topics/${topicId}`, { method: "DELETE" });
    }

    return nextTopics.map((t, idx) => ({ ...t, position: idx }));
  }

  async function uploadIntroVideo(courseIdToUse: string) {
    if (videoProvider === "html5") {
      if (!videoFile) return;
      const form = new FormData();
      form.append("provider", "html5");
      form.append("file", videoFile);
      await fetchJson(`/api/v2/courses/${courseIdToUse}/intro-video`, { method: "POST", body: form });
      setVideoFile(null);
      return;
    }

    if (!videoUrl.trim()) return;
    const form = new FormData();
    form.append("provider", videoProvider);
    form.append("url", videoUrl.trim());
    await fetchJson(`/api/v2/courses/${courseIdToUse}/intro-video`, { method: "POST", body: form });
  }

  function applyVideoFile(file: File | null) {
    if (!file) return;
    if (file.type !== "video/mp4") {
      toast.error("Invalid video type. Allowed: MP4.");
      return;
    }
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error("Video is too large. Max size is 50MB.");
      return;
    }
    setVideoFile(file);
    if (status === "published") setNeedsRepublish(true);
  }

  async function uploadThumbnail(courseIdToUse: string) {
    if (!thumbnailFile) return;
    const form = new FormData();
    form.append("file", thumbnailFile);
    const { data } = await fetchJson<{ cover_image_url: string }>(`/api/v2/courses/${courseIdToUse}/thumbnail`, {
      method: "POST",
      body: form,
    });
    setThumbnailUrl(data.cover_image_url);
    setThumbnailFile(null);
  }

  async function removeThumbnailOnServer(courseIdToUse: string) {
    if (!pendingThumbnailRemoval) return;
    await fetchJson(`/api/v2/courses/${courseIdToUse}/thumbnail`, { method: "DELETE" });
    setPendingThumbnailRemoval(false);
    setThumbnailUrl("");
    setThumbnailFile(null);
  }

  function applyThumbnailFile(file: File | null) {
    if (!file) return;
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowed.has(file.type)) {
      toast.error("Invalid thumbnail type. Allowed: PNG, JPG, WebP.");
      return;
    }
    const maxBytes = 10 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error("Thumbnail is too large. Max size is 10MB.");
      return;
    }
    setPendingThumbnailRemoval(false);
    setThumbnailFile(file);
    if (status === "published") setNeedsRepublish(true);
  }

  function removeThumbnailLocal() {
    // Clear input value so selecting the same file again re-triggers onChange.
    try {
      if (thumbnailInputRef.current) thumbnailInputRef.current.value = "";
    } catch {
      // ignore
    }

    setThumbnailFile(null);
    setThumbnailUrl("");
    setPendingThumbnailRemoval(true);
    if (status === "published") setNeedsRepublish(true);
  }

  async function saveDraft(opts?: { afterSuccessNavigateTo?: string; showSuccessModal?: boolean }) {
    setError(null);
    setIsBusy(true);
    try {
      const id = await ensureCourseDraftExists();
      const aboutFinal = await finalizeCourseAboutInlineImages(id);
      const saved = await saveCore(id, { aboutHtmlOverride: aboutFinal });
      await saveMembers(id);
      await uploadIntroVideo(id);
      await removeThumbnailOnServer(id);
      await uploadThumbnail(id);
      const syncedTopics = await syncCurriculumToServer(id);
      setTopics(syncedTopics);
      setPendingDeletedItemIds([]);
      setPendingDeletedTopicIds([]);
      for (const v of Object.values(pendingLessonUploadsByItemId ?? {})) {
        revokeInlineQueueObjectUrls(v?.inlineImages ?? {});
      }
      revokeInlineQueueObjectUrls(pendingCourseAboutInlineImages ?? {});
      setPendingLessonUploadsByItemId({});
      setPendingCourseAboutInlineImages({});
      await fetchJson(`/api/v2/courses/${id}/save-draft`, { method: "POST" });
      const finalSlug = saved.slug ?? slug;
      setSlug(finalSlug);
      setStatus("draft");
      setNeedsRepublish(false);

      // Mark as saved (used by leave-guard / unsaved banner).
      savedSnapshotRef.current = {
        courseId: id,
        status: "draft",
        title,
        slug: finalSlug,
        isSlugManuallyEdited,
        aboutHtml: aboutFinal,
        excerpt,
        difficulty,
        whatWillLearn,
        hours,
        minutes,
        materialsIncluded,
        requirements,
        videoProvider,
        videoUrl,
        thumbnailUrl,
        selectedMemberIds: [...selectedMemberIds],
        topics: deepClone(syncedTopics),
      };
      savedSignatureRef.current = JSON.stringify({
        courseId: id,
        status: "draft",
        title,
        slug: finalSlug,
        isSlugManuallyEdited,
        aboutHtml: aboutFinal,
        excerpt,
        difficulty,
        whatWillLearn,
        hours,
        minutes,
        materialsIncluded,
        requirements,
        videoProvider,
        videoUrl,
        thumbnailUrl,
        members: [...selectedMemberIds].sort(),
        topicsSig: syncedTopics.map((t) => ({
          id: t.id,
          title: t.title,
          summary: t.summary ?? null,
          position: t.position,
          items: (t.items ?? []).map((it) => ({
            id: it.id,
            item_type: it.item_type,
            title: it.title ?? null,
            position: it.position,
            payload_json: it.payload_json ?? {},
          })),
        })),
        pendingDeletedTopicIds: [],
        pendingDeletedItemIds: [],
        uploadSig: [],
        hasIntroVideoFile: false,
        hasThumbnailFile: false,
      });

      const navigateTo = opts?.afterSuccessNavigateTo ?? null;
      const showSuccessModal = opts?.showSuccessModal ?? !navigateTo;
      if (navigateTo) {
        router.push(navigateTo);
        return;
      }

      if (showSuccessModal) {
        setSuccessModal({
          title: "Draft saved",
          description: "Your course draft has been saved successfully.",
        });
      }
      if (mode === "create") {
        router.replace(`/org/${orgSlug}/courses/${id}/edit-v2`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save draft.");
    } finally {
      setIsBusy(false);
    }
  }

  async function publishCourse(opts?: { afterSuccessNavigateTo?: string; showSuccessModal?: boolean }) {
    setError(null);
    setIsBusy(true);
    const wasPublished = status === "published";
    try {
      const id = await ensureCourseDraftExists();
      const aboutFinal = await finalizeCourseAboutInlineImages(id);
      const saved = await saveCore(id, { aboutHtmlOverride: aboutFinal });
      await saveMembers(id);
      await uploadIntroVideo(id);
      await removeThumbnailOnServer(id);
      await uploadThumbnail(id);
      const syncedTopics = await syncCurriculumToServer(id);
      setTopics(syncedTopics);
      setPendingDeletedItemIds([]);
      setPendingDeletedTopicIds([]);
      for (const v of Object.values(pendingLessonUploadsByItemId ?? {})) {
        revokeInlineQueueObjectUrls(v?.inlineImages ?? {});
      }
      revokeInlineQueueObjectUrls(pendingCourseAboutInlineImages ?? {});
      setPendingLessonUploadsByItemId({});
      setPendingCourseAboutInlineImages({});
      await fetchJson(`/api/v2/courses/${id}/publish`, { method: "POST" });
      const finalSlug = saved.slug ?? slug;
      setSlug(finalSlug);
      setStatus("published");
      setNeedsRepublish(false);

      savedSnapshotRef.current = {
        courseId: id,
        status: "published",
        title,
        slug: finalSlug,
        isSlugManuallyEdited,
        aboutHtml: aboutFinal,
        excerpt,
        difficulty,
        whatWillLearn,
        hours,
        minutes,
        materialsIncluded,
        requirements,
        videoProvider,
        videoUrl,
        thumbnailUrl,
        selectedMemberIds: [...selectedMemberIds],
        topics: deepClone(syncedTopics),
      };
      savedSignatureRef.current = JSON.stringify({
        courseId: id,
        status: "published",
        title,
        slug: finalSlug,
        isSlugManuallyEdited,
        aboutHtml: aboutFinal,
        excerpt,
        difficulty,
        whatWillLearn,
        hours,
        minutes,
        materialsIncluded,
        requirements,
        videoProvider,
        videoUrl,
        thumbnailUrl,
        members: [...selectedMemberIds].sort(),
        topicsSig: syncedTopics.map((t) => ({
          id: t.id,
          title: t.title,
          summary: t.summary ?? null,
          position: t.position,
          items: (t.items ?? []).map((it) => ({
            id: it.id,
            item_type: it.item_type,
            title: it.title ?? null,
            position: it.position,
            payload_json: it.payload_json ?? {},
          })),
        })),
        pendingDeletedTopicIds: [],
        pendingDeletedItemIds: [],
        uploadSig: [],
        hasIntroVideoFile: false,
        hasThumbnailFile: false,
      });

      const navigateTo = opts?.afterSuccessNavigateTo ?? null;
      const showSuccessModal = opts?.showSuccessModal ?? !navigateTo;
      if (navigateTo) {
        router.push(navigateTo);
        return;
      }

      if (showSuccessModal) {
        setSuccessModal({
          title: wasPublished ? "Course republished" : "Course published",
          description: wasPublished ? "Your updates are now live for learners." : "Your course has been published successfully.",
        });
      }
      if (mode === "create") {
        router.replace(`/org/${orgSlug}/courses/${id}/edit-v2`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to publish course.");
    } finally {
      setIsBusy(false);
    }
  }

  async function createOrUpdateTopic() {
    if (!topicModal) return;
    setError(null);
    try {
      if (topicModal.mode === "create") {
        const newTopicId = makeTempId("tmp_topic");
        setTopics((prev) => [
          ...prev,
          {
            id: newTopicId,
            title: topicModal.title.trim() || "New topic",
            summary: topicModal.summary?.trim() || null,
            position: prev.length,
            items: [],
          },
        ]);
        setTopicExpanded(newTopicId, true);
        toast.info("Topic added locally. Click Save Draft or Publish/Republish to apply changes.");
      } else if (topicModal.topicId) {
        setTopics((prev) =>
          prev.map((t) =>
            t.id === topicModal.topicId
              ? { ...t, title: topicModal.title.trim() || t.title, summary: topicModal.summary?.trim() || null }
              : t
          )
        );
        toast.info("Topic updated locally. Click Save Draft or Publish/Republish to apply changes.");
      }
      setTopicModal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save topic.");
    }
  }

  async function deleteTopic(topicId: string) {
    if (!confirm("Delete this topic and all content inside it?")) return;
    setError(null);
    setIsBusy(true);
    try {
      setTopics((prev) => prev.filter((t) => t.id !== topicId));
      setTopicExpanded(topicId, false);
      if (!isTempId(topicId)) {
        setPendingDeletedTopicIds((prev) => (prev.includes(topicId) ? prev : [...prev, topicId]));
      }
      if (status === "published") setNeedsRepublish(true);
      toast.info("Topic removed locally. Click Save Draft or Publish/Republish to apply changes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete topic.");
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteTopicItem(topicId: string, itemId: string) {
    if (!confirm("Delete this content item?")) return;
    setError(null);
    setIsBusy(true);
    try {
      setTopics((prev) => prev.map((t) => (t.id === topicId ? { ...t, items: t.items.filter((i) => i.id !== itemId) } : t)));
      if (!isTempId(itemId)) {
        setPendingDeletedItemIds((prev) => (prev.includes(itemId) ? prev : [...prev, itemId]));
      }
      if (status === "published") setNeedsRepublish(true);
      toast.info("Item removed locally. Click Save Draft or Publish/Republish to apply changes.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete item.");
    } finally {
      setIsBusy(false);
    }
  }

  async function saveLesson() {
    if (!itemModal || itemModal.itemType !== "lesson") return;
    setError(null);
    try {
      const normalizedBlocks = (itemModal.contentBlocks ?? []).map((b) => ({ ...b, html: (b?.html ?? "") }));
      const persistedBlocks = normalizedBlocks.map((b) => b.html);
      const joinedHtml = joinLessonBlocksHtml(normalizedBlocks);

      const basePayload: Record<string, unknown> = {
        kind: "lesson_v1",
        lesson_name: itemModal.lessonName.trim() || "Draft Lesson",
        content_blocks: persistedBlocks,
        content_html: joinedHtml,
        feature_image: itemModal.featureImageStoragePath
          ? { storage_path: itemModal.featureImageStoragePath }
          : null,
        video: itemModal.videoProvider === "html5"
          ? (itemModal.videoStoragePath ? { provider: "html5", storage_path: itemModal.videoStoragePath } : { provider: "html5" })
          : { provider: itemModal.videoProvider, url: itemModal.videoUrl.trim() || null },
        playback_time: { hours: Math.max(0, itemModal.playbackHours || 0), minutes: Math.min(59, Math.max(0, itemModal.playbackMinutes || 0)) },
        attachments: itemModal.existingAttachments ?? [],
      };

      const lessonTitle = itemModal.lessonName.trim() || "Draft Lesson";
      const localItemId = itemModal.mode === "create" ? makeTempId("tmp_item") : (itemModal.itemId as string);

      const nextItem: CourseTopicItem = {
        id: localItemId,
        item_type: "lesson",
        title: lessonTitle,
        position: 0,
        payload_json: basePayload,
      };

      setTopics((prev) =>
        prev.map((t) => {
          if (t.id !== itemModal.topicId) return t;
          if (itemModal.mode === "create") {
            const pos = t.items.length;
            return { ...t, items: [...t.items, { ...nextItem, position: pos }] };
          }
          return { ...t, items: t.items.map((it) => (it.id === localItemId ? { ...nextItem, position: it.position } : it)) };
        })
      );

      setPendingLessonUploadsByItemId((prev) => ({
        ...prev,
        [localItemId]: (() => {
          const existing = prev[localItemId] ?? null;

          // Preserve any already-pending uploads unless the user explicitly selects new files.
          const featureImageFile = itemModal.featureImageFile ?? existing?.featureImageFile ?? null;
          const videoFile =
            itemModal.videoProvider === "html5"
              ? (itemModal.videoFile ?? existing?.videoFile ?? null)
              : null;
          const attachments = [...(existing?.attachments ?? []), ...(itemModal.attachments ?? [])];

          // Inline images: merge, then keep only those still referenced across ALL lesson blocks.
          const mergedInline = { ...(existing?.inlineImages ?? {}), ...(itemModal.inlineImages ?? {}) };
          const inlineImages = pruneQueueByBlocksWithRevoke(mergedInline, normalizedBlocks);

          return { featureImageFile, videoFile, attachments, inlineImages };
        })(),
      }));

      setItemModal(null);
      toast.info("Lesson updated locally. Click Save Draft or Publish/Republish to apply changes.");
      if (status === "published") setNeedsRepublish(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save lesson.");
    }
  }

  function cancelLessonModal() {
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return null;
      revokeInlineQueueObjectUrls(prev.inlineImages ?? {});
      return null;
    });
  }

  function upsertQuizLocally(args: { mode: "create" | "edit"; topicId: string; itemId: string | null; title: string; payload_json: Record<string, unknown> }): string {
    const localItemId = args.mode === "create" ? makeTempId("tmp_item") : (args.itemId as string);
    const nextItem: CourseTopicItem = {
      id: localItemId,
      item_type: "quiz",
      title: args.title.trim() || "Draft Quiz",
      position: 0,
      payload_json: args.payload_json,
    };
    setTopics((prev) =>
      prev.map((t) => {
        if (t.id !== args.topicId) return t;
        if (args.mode === "create") {
          const pos = t.items.length;
          return { ...t, items: [...t.items, { ...nextItem, position: pos }] };
        }
        return { ...t, items: t.items.map((it) => (it.id === localItemId ? { ...nextItem, position: it.position } : it)) };
      })
    );
    if (status === "published") setNeedsRepublish(true);
    return localItemId;
  }

  function openEditLesson(topicId: string, item: CourseTopicItem) {
    const p = (item.payload_json ?? {}) as Record<string, unknown>;
    const playback = (p.playback_time ?? {}) as { hours?: unknown; minutes?: unknown };
    const video = (p.video ?? {}) as { provider?: unknown; url?: unknown; storage_path?: unknown };
    const feature = (p.feature_image ?? {}) as { storage_path?: unknown };
    const attachments = Array.isArray(p.attachments) ? (p.attachments as LessonModalState["existingAttachments"]) : [];
    setItemModal({
      itemType: "lesson",
      mode: "edit",
      topicId,
      itemId: item.id,
      lessonName: (item.title ?? (p.lesson_name as string) ?? "").toString(),
      contentBlocks: extractLessonBlocksFromPayload(p),
      inlineImages: {},
      featureImageFile: null,
      featureImagePreviewUrl: null,
      featureImageStoragePath: typeof feature.storage_path === "string" ? feature.storage_path : null,
      videoProvider: (video.provider === "youtube" || video.provider === "vimeo" ? (video.provider as LessonVideoProvider) : "html5"),
      videoUrl: typeof video.url === "string" ? video.url : "",
      videoFile: null,
      videoStoragePath: typeof video.storage_path === "string" ? video.storage_path : null,
      playbackHours: Number.isFinite(Number(playback.hours)) ? Number(playback.hours) : 0,
      playbackMinutes: Number.isFinite(Number(playback.minutes)) ? Number(playback.minutes) : 0,
      attachments: [],
      existingAttachments: attachments,
    });
  }

  function openEditQuiz(topicId: string, item: CourseTopicItem) {
    const p = (item.payload_json ?? {}) as Record<string, unknown>;
    setItemModal({
      itemType: "quiz",
      mode: "edit",
      topicId,
      itemId: item.id,
      title: (item.title ?? (p.title as string) ?? "").toString(),
      summary: typeof p.summary === "string" ? p.summary : "",
      payload_json: (item.payload_json ?? null) as Record<string, unknown> | null,
    });
  }

  function applyLessonFeatureImageFile(file: File | null) {
    if (!file) return;
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowed.has(file.type)) {
      toast.error("Invalid feature image type. Allowed: PNG, JPG, WebP.");
      return;
    }
    const maxBytes = 10 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error("Feature image is too large. Max size is 10MB.");
      return;
    }
    setItemModal((prev) => (prev && prev.itemType === "lesson" ? { ...prev, featureImageFile: file } : prev));
  }

  function removeLessonFeatureImage() {
    // Clear input value so selecting the same file again re-triggers onChange.
    try {
      const el = document.getElementById("lesson-feature-image-input") as HTMLInputElement | null;
      if (el) el.value = "";
    } catch {
      // ignore
    }

    // Clear modal state (preview + file + persisted storage path).
    setItemModal((prev) => {
      if (!prev || prev.itemType !== "lesson") return prev;
      return { ...prev, featureImageFile: null, featureImagePreviewUrl: null, featureImageStoragePath: null };
    });

    // If there was already a pending upload queued for this item, explicitly clear it
    // so "remove" wins over the "preserve pending uploads" rule.
    if (itemModal && itemModal.itemType === "lesson" && itemModal.mode === "edit" && itemModal.itemId) {
      const id = itemModal.itemId;
      setPendingLessonUploadsByItemId((prev) => {
        const existing = prev[id];
        if (!existing) return prev;
        return { ...prev, [id]: { ...existing, featureImageFile: null } };
      });
    }

    if (status === "published") setNeedsRepublish(true);
  }

  function applyLessonVideoFile(file: File | null) {
    if (!file) return;
    if (file.type !== "video/mp4") {
      toast.error("Invalid video type. Allowed: MP4.");
      return;
    }
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error("Video is too large. Max size is 50MB.");
      return;
    }
    setItemModal((prev) => (prev && prev.itemType === "lesson" ? { ...prev, videoFile: file } : prev));
  }

  function applyLessonAttachmentFiles(files: File[]) {
    const maxFiles = 10;
    const maxBytesPerFile = 50 * 1024 * 1024;
    if (files.length > maxFiles) {
      toast.error("Too many attachments. Max 10 files.");
      return;
    }
    for (const f of files) {
      if (f.size > maxBytesPerFile) {
        toast.error(`Attachment too large: ${f.name} (max 50MB).`);
        return;
      }
    }
    setItemModal((prev) => (prev && prev.itemType === "lesson" ? { ...prev, attachments: files } : prev));
  }

  async function onTopicDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = topics.findIndex((t) => t.id === active.id);
    const newIndex = topics.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const next = topics.slice();
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    const withPosition = next.map((t, idx) => ({ ...t, position: idx }));
    setTopics(withPosition);
    if (status === "published") setNeedsRepublish(true);
  }

  return (
    <div className="mx-auto w-full space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm">
        <div className="text-sm text-muted-foreground">
          Course Builder <span className="font-medium text-foreground">V2</span> ({status})
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!canPreview}
            title={!previewHref ? "Save the course first to enable preview." : hasUnsavedChanges ? "Save changes to preview the latest version." : "Preview course"}
            onClick={() => {
              if (!previewHref) {
                toast.info("Save the course first to enable preview.");
                return;
              }
              if (hasUnsavedChanges) {
                toast.info("You have unsaved changes. Save Draft or Publish/Republish to preview the latest version.");
                return;
              }
              window.open(previewHref, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink className="h-4 w-4" />
            Preview
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (status === "published") {
                setConfirmUnpublishDraftOpen(true);
                return;
              }
              void saveDraft();
            }}
            disabled={isBusy}
          >
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Draft
          </Button>
          {status === "published" && !needsRepublish ? (
            <Button
              type="button"
              disabled
              className="bg-green-600 text-white hover:bg-green-600 disabled:opacity-100 disabled:pointer-events-none"
            >
              <Check className="h-4 w-4" />
              Published
            </Button>
          ) : (
            <Button type="button" onClick={() => void publishCourse()} disabled={isBusy || !canPublish}>
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {status === "published" ? "Republish" : "Publish"}
            </Button>
          )}
          <Button
            variant="ghost"
            type="button"
            size="icon-sm"
            aria-label="Back"
            title="Back"
            onClick={() => {
              if (hasUnsavedChanges) {
                setLeavePrompt({ href: backHref });
                return;
              }
              router.push(backHref);
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      {hasUnsavedChanges ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900">
          You have unsaved changes. Click <span className="font-medium">Save Draft</span> or <span className="font-medium">Publish/Republish</span> to apply them.
        </div>
      ) : null}

      <DetailsSection title="Course Info">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Course Title</label>
            <Input
            value={title}
            onChange={(e) => {
              const nextTitle = e.target.value;
              setTitle(nextTitle);
                if (status === "published") setNeedsRepublish(true);
              if (!isSlugManuallyEdited) {
                setSlug(normalizeSlug(nextTitle));
              }
            }}
              placeholder="Enter a clear course name (e.g. WordPress SEO Fundamentals)"
              className="mt-1"
            />
            <FieldHint>This is the main course title shown to learners in course listings and on the course page.</FieldHint>
          </div>

          <div>
            <label className="text-sm font-medium">Course Slug</label>
            <Input
            value={slug}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw.trim()) {
                setSlug("");
                setIsSlugManuallyEdited(false);
                  if (status === "published") setNeedsRepublish(true);
                return;
              }
              setSlug(normalizeSlug(raw));
              setIsSlugManuallyEdited(true);
                if (status === "published") setNeedsRepublish(true);
            }}
            placeholder="course-url-slug"
              className="mt-1"
            />
            <FieldHint>Lowercase letters, numbers and dashes only.</FieldHint>
          </div>

          <div className="text-sm">
            <span className="text-muted-foreground">Permalink: </span>
            <span className="font-medium break-all">{permalink || "Will be generated from course name"}</span>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">About Course</p>
            <RichTextEditorWithUploads
              value={aboutHtml}
              onChange={(html) => {
                setAboutHtml(html);
                setPendingCourseAboutInlineImages((prev) => pruneQueueByHtml(prev ?? {}, html));
                if (status === "published") setNeedsRepublish(true);
              }}
              placeholder="Write a detailed course description for visitors before enrollment."
              queue={pendingCourseAboutInlineImages}
              setQueue={(updater) => {
                setPendingCourseAboutInlineImages((prev) => {
                  const next = typeof updater === "function" ? updater(prev ?? {}) : updater;
                  return next ?? {};
                });
                if (status === "published") setNeedsRepublish(true);
              }}
            />
            <FieldHint>This detailed description is visible to users before they enroll in the course.</FieldHint>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Excerpt</p>
            <Textarea
              value={excerpt}
              onChange={(e) => {
                setExcerpt(e.target.value.slice(0, 200));
                if (status === "published") setNeedsRepublish(true);
              }}
              placeholder="Write a short summary shown in course lists."
              className="min-h-[90px]"
            />
            <div className="flex items-center justify-between">
              <FieldHint>Short preview text shown under the course card image.</FieldHint>
              <p className="text-xs text-muted-foreground">{excerpt.length}/200</p>
            </div>
          </div>
        </div>
      </DetailsSection>

      <DetailsSection title="Video">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Course Intro Video</label>
            <select
              className="mt-1 h-10 w-full rounded-md border bg-transparent px-3 text-sm"
              value={videoProvider}
              onChange={(e) => {
                setVideoProvider(e.target.value as "html5" | "youtube" | "vimeo");
                setVideoFile(null);
                if (status === "published") setNeedsRepublish(true);
              }}
            >
              <option value="html5">HTML 5 (mp4)</option>
              <option value="youtube">YouTube</option>
              <option value="vimeo">Vimeo</option>
            </select>
            <FieldHint>Select where intro video is sourced from (file upload or full external URL).</FieldHint>
          </div>

          {videoProvider === "html5" ? (
            <div>
              <div
                role="button"
                tabIndex={0}
                onClick={() => videoInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    videoInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsVideoDragActive(true);
                }}
                onDragLeave={() => setIsVideoDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsVideoDragActive(false);
                  const file = e.dataTransfer.files?.[0] ?? null;
                  applyVideoFile(file);
                }}
                className={cn(
                  "rounded-md border border-dashed border-primary bg-muted/10 p-10 text-center transition-colors cursor-pointer",
                  isVideoDragActive ? "border-primary bg-primary/5" : ""
                )}
              >
                <p className="text-sm font-medium">Drag & Drop Your Video</p>
                <p className="mt-1 text-xs text-muted-foreground">File format: .mp4 • Max size: 50MB</p>
                <div className="mt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => videoInputRef.current?.click()}>
                    Browse file
                  </Button>
                </div>
                {videoFile ? <p className="mt-3 text-xs text-muted-foreground">Selected: {videoFile.name}</p> : null}
              </div>
              <Input
                ref={videoInputRef}
                type="file"
                accept="video/mp4"
                className="hidden"
                onChange={(e) => applyVideoFile(e.target.files?.[0] ?? null)}
              />
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium">External URL</label>
              <div className="mt-2 rounded-md border border-dashed border-primary bg-muted/10 p-4">
                <Input
                  value={videoUrl}
                  onChange={(e) => {
                    setVideoUrl(e.target.value);
                    if (status === "published") setNeedsRepublish(true);
                  }}
                  placeholder={`Paste ${videoProvider === "youtube" ? "YouTube" : "Vimeo"} video URL`}
                />
              </div>
              <FieldHint>Provide the full share URL for the selected provider.</FieldHint>
            </div>
          )}
        </div>
      </DetailsSection>

      <DetailsSection title="Course Thumbnail">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="w-full md:w-[300px]">
            <div
              role="button"
              tabIndex={0}
              onClick={() => thumbnailInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  thumbnailInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsThumbnailDragActive(true);
              }}
              onDragLeave={() => setIsThumbnailDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsThumbnailDragActive(false);
                const file = e.dataTransfer.files?.[0] ?? null;
                applyThumbnailFile(file);
              }}
              className={cn(
                "relative h-[180px] cursor-pointer rounded-md border border-dashed flex items-center justify-center overflow-hidden bg-muted/10 transition-colors",
                (thumbnailObjectUrl || thumbnailUrl) ? "border-solid" : "",
                isThumbnailDragActive ? "border-primary bg-primary/5" : ""
              )}
            >
              {thumbnailObjectUrl || thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbnailObjectUrl ?? thumbnailUrl} alt="Course thumbnail preview" className="h-full w-full object-cover" />
              ) : (
                <div className="px-3 text-center">
                  <p className="text-xs text-muted-foreground">Drop or choose image</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Click here or drag file into this area</p>
                </div>
              )}

              {thumbnailObjectUrl || thumbnailUrl ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove thumbnail"
                  title="Remove thumbnail"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removeThumbnailLocal();
                  }}
                  className="absolute right-2 top-2 bg-background/80 hover:bg-background text-destructive"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            <Input
              ref={thumbnailInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => applyThumbnailFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">Size:</span> 700×430 pixels
              </div>
              <div>
                <span className="font-medium text-foreground">File support:</span> PNG, JPG, WebP
              </div>
              <div className="text-xs">Maximum upload size: 10MB</div>
            </div>
            <Button type="button" variant="default" size="sm" onClick={() => thumbnailInputRef.current?.click()} className="w-fit">
              <Upload className="h-4 w-4" />
              Upload Image
            </Button>
          </div>
        </div>
      </DetailsSection>

      <DetailsSection title="Course Settings">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1 rounded-md border bg-muted/10 p-3">
            <div className="flex items-center gap-2 rounded-md bg-background border px-3 py-2 text-sm font-medium">
              <Settings className="h-4 w-4 text-muted-foreground" />
              General
            </div>
          </div>
          <div className="md:col-span-2 space-y-5">
            <div className="relative">
              <label className="text-sm font-medium">Members</label>
              <button
                type="button"
                className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-left text-sm flex items-center justify-between hover:bg-muted/10 transition-colors cursor-pointer"
                onClick={() => setMembersOpen((v) => !v)}
              >
                <span className="truncate">{selectedMemberIds.size > 0 ? `${selectedMemberIds.size} member(s) selected` : "Select members"}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
              <FieldHint>Select which members should have access to this course (default: none selected).</FieldHint>

              {membersOpen ? (
                <div className="absolute z-20 mt-2 w-full rounded-md border bg-card shadow-lg p-3 space-y-2">
                  <Input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search members..." />
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={(e) => {
                        const checked = e.target.checked;
                            if (status === "published") setNeedsRepublish(true);
                        setSelectedMemberIds((prev) => {
                          const next = new Set(prev);
                          for (const m of filteredMembers) {
                            if (checked) next.add(m.id);
                            else next.delete(m.id);
                          }
                          return next;
                        });
                      }}
                    />
                    Select all in current search
                  </label>
                  <div className="max-h-56 overflow-auto space-y-1 border rounded-md p-2 bg-background">
                    {filteredMembers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No members found.</p>
                    ) : (
                      filteredMembers.map((m) => (
                        <label key={m.id} className="flex items-center gap-2 text-sm rounded-md px-2 py-1 hover:bg-muted/10 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedMemberIds.has(m.id)}
                            onChange={(e) =>
                              setSelectedMemberIds((prev) => {
                                if (status === "published") setNeedsRepublish(true);
                                const next = new Set(prev);
                                if (e.target.checked) next.add(m.id);
                                else next.delete(m.id);
                                return next;
                              })
                            }
                          />
                          <span className="truncate">{m.label}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              <label className="text-sm font-medium">Difficulty Level</label>
              <select
                className="mt-1 h-10 w-full rounded-md border bg-transparent px-3 text-sm"
                value={difficulty ?? "all_levels"}
                onChange={(e) => {
                  setDifficulty(e.target.value as CourseV2["difficulty_level"]);
                  if (status === "published") setNeedsRepublish(true);
                }}
              >
                <option value="all_levels">All Levels</option>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="expert">Expert</option>
              </select>
              <FieldHint>Defines the expected skill level for learners taking this course.</FieldHint>
            </div>
          </div>
        </div>
      </DetailsSection>

      <DetailsSection title="Course Builder">
        <div className="space-y-3">
          {dndReady ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onTopicDragEnd(e)}>
              <SortableContext items={topics.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {topics.map((topic) => (
                    <SortableTopicRow
                      key={topic.id}
                      topic={topic}
                      expanded={expandedTopicIds.has(topic.id)}
                      onToggle={() => setTopicExpanded(topic.id, !expandedTopicIds.has(topic.id))}
                      onEdit={() =>
                        setTopicModal({
                          mode: "edit",
                          topicId: topic.id,
                          title: topic.title,
                          summary: topic.summary ?? "",
                        })
                      }
                      onDelete={() => void deleteTopic(topic.id)}
                      onEditLessonItem={(topicId, item) => openEditLesson(topicId, item)}
                      onEditQuizItem={(topicId, item) => openEditQuiz(topicId, item)}
                      onReorderItems={reorderItemsLocally}
                      onDeleteItem={(topicId, itemId) => void deleteTopicItem(topicId, itemId)}
                      onAddLesson={() =>
                        setItemModal({
                        itemType: "lesson",
                        mode: "create",
                        topicId: topic.id,
                        itemId: null,
                        lessonName: "Draft Lesson",
                        contentBlocks: [{ id: makeBlockId(), html: "" }],
                        inlineImages: {},
                        featureImageFile: null,
                        featureImagePreviewUrl: null,
                        featureImageStoragePath: null,
                        videoProvider: "html5",
                        videoUrl: "",
                        videoFile: null,
                        videoStoragePath: null,
                        playbackHours: 0,
                        playbackMinutes: 0,
                        attachments: [],
                        existingAttachments: [],
                        })
                      }
                      onAddQuiz={() =>
                        setItemModal({
                        itemType: "quiz",
                        mode: "create",
                        topicId: topic.id,
                        itemId: null,
                        title: "",
                        summary: "",
                        payload_json: null,
                        })
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="space-y-2">
              {topics.map((topic) => (
                <StaticTopicRow
                  key={topic.id}
                  topic={topic}
                  expanded={expandedTopicIds.has(topic.id)}
                  onToggle={() => setTopicExpanded(topic.id, !expandedTopicIds.has(topic.id))}
                  onEdit={() =>
                    setTopicModal({
                      mode: "edit",
                      topicId: topic.id,
                      title: topic.title,
                      summary: topic.summary ?? "",
                    })
                  }
                  onDelete={() => void deleteTopic(topic.id)}
                  onEditLessonItem={(topicId, item) => openEditLesson(topicId, item)}
                  onEditQuizItem={(topicId, item) => openEditQuiz(topicId, item)}
                  onDeleteItem={(topicId, itemId) => void deleteTopicItem(topicId, itemId)}
                  onAddLesson={() =>
                    setItemModal({
                      itemType: "lesson",
                      mode: "create",
                      topicId: topic.id,
                      itemId: null,
                      lessonName: "Draft Lesson",
                      contentBlocks: [{ id: makeBlockId(), html: "" }],
                      inlineImages: {},
                      featureImageFile: null,
                      featureImagePreviewUrl: null,
                      featureImageStoragePath: null,
                      videoProvider: "html5",
                      videoUrl: "",
                      videoFile: null,
                      videoStoragePath: null,
                      playbackHours: 0,
                      playbackMinutes: 0,
                      attachments: [],
                      existingAttachments: [],
                    })
                  }
                  onAddQuiz={() =>
                    setItemModal({
                      itemType: "quiz",
                      mode: "create",
                      topicId: topic.id,
                      itemId: null,
                      title: "",
                      summary: "",
                      payload_json: null,
                    })
                  }
                />
              ))}
            </div>
          )}

          <Button
            type="button"
            size="sm"
            onClick={() =>
              setTopicModal({
                mode: "create",
                topicId: null,
                title: "",
                summary: "",
              })
            }
            className="w-fit"
          >
            <Plus className="h-4 w-4" />
            Add new topic
          </Button>
        </div>
      </DetailsSection>

      <DetailsSection title="Additional Data">
        <div className="space-y-5">
          <div>
            <label className="text-sm font-medium">What Will I Learn?</label>
            <Textarea
              className="mt-1"
              value={whatWillLearn}
              onChange={(e) => {
                setWhatWillLearn(e.target.value);
                if (status === "published") setNeedsRepublish(true);
              }}
              placeholder="Describe what learners will gain from this course."
            />
            <FieldHint>Shown to help potential learners understand expected outcomes.</FieldHint>
          </div>

          <div>
            <label className="text-sm font-medium">Total Course Duration</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-1">
              <div>
                <Input
                  type="number"
                  min={0}
                  max={999}
                  value={hours}
                  onChange={(e) => {
                    setHours(Math.max(0, Number(e.target.value || 0)));
                    if (status === "published") setNeedsRepublish(true);
                  }}
                  placeholder="Hours"
                />
                <FieldHint>Total hours for this course.</FieldHint>
              </div>
              <div>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={minutes}
                  onChange={(e) => {
                    setMinutes(Math.min(59, Math.max(0, Number(e.target.value || 0))));
                    if (status === "published") setNeedsRepublish(true);
                  }}
                  placeholder="Minutes"
                />
                <FieldHint>Additional minutes for this course.</FieldHint>
              </div>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Materials Included</label>
            <Textarea
              className="mt-1"
              value={materialsIncluded}
              onChange={(e) => {
                setMaterialsIncluded(e.target.value);
                if (status === "published") setNeedsRepublish(true);
              }}
              placeholder="Describe included materials, resources or downloads."
            />
            <FieldHint>Displayed on the course page so learners know what materials are included.</FieldHint>
          </div>

          <div>
            <label className="text-sm font-medium">Requirements/Instructions</label>
            <Textarea
              className="mt-1"
              value={requirements}
              onChange={(e) => {
                setRequirements(e.target.value);
                if (status === "published") setNeedsRepublish(true);
              }}
              placeholder="Add prerequisites or important instructions before learners start."
            />
            <FieldHint>Use this field to list prerequisites, setup, or mandatory learner instructions.</FieldHint>
          </div>
        </div>
      </DetailsSection>

      {topicModal ? (
        <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto">
          <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
            <div className="w-full max-w-xl rounded-lg border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="font-semibold">{topicModal.mode === "create" ? "Add Topic" : "Edit Topic"}</h3>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => setTopicModal(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-sm font-medium">Topic Name</label>
                <Input
                  value={topicModal.title}
                  onChange={(e) => setTopicModal((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
                  placeholder="Name this topic for your internal course structure"
                />
                <FieldHint>This topic name is visible to creators in the builder and helps organize course flow.</FieldHint>
              </div>
              <div>
                <label className="text-sm font-medium">Topic Summary</label>
                <Textarea
                  value={topicModal.summary}
                  onChange={(e) => setTopicModal((prev) => (prev ? { ...prev, summary: e.target.value } : prev))}
                  placeholder="Write a short summary for this topic"
                  className="min-h-[120px]"
                />
                <FieldHint>Optional summary used in builder previews and internal planning.</FieldHint>
              </div>
            </div>
            <div className="flex items-center justify-between border-t px-4 py-3">
              <Button type="button" variant="outline" onClick={() => setTopicModal(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void createOrUpdateTopic()} disabled={isBusy || topicModal.title.trim().length < 2}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {topicModal.mode === "create" ? "Add Topic" : "Save Topic"}
              </Button>
            </div>
            </div>
          </div>
        </div>
      ) : null}

      {itemModal && itemModal.itemType === "quiz" ? (
        <QuizWizardModal
          mode={itemModal.mode}
          initialTitle={itemModal.title}
          initialSummary={itemModal.summary}
          initialPayloadJson={itemModal.payload_json}
          onClose={() => setItemModal(null)}
          onSave={({ title: quizTitle, payload_json, inline_images }) => {
            const localItemId = upsertQuizLocally({
              mode: itemModal.mode,
              topicId: itemModal.topicId,
              itemId: itemModal.itemId,
              title: quizTitle,
              payload_json,
            });
            if (inline_images && Object.keys(inline_images).length) {
              // Merge into pending uploads for this quiz item so they upload on Save Draft / Publish.
              setPendingLessonUploadsByItemId((prev) => {
                const existing = prev[localItemId] ?? { featureImageFile: null, videoFile: null, attachments: [], inlineImages: {} };
                // Keep only IDs that are still referenced in the quiz payload.
                const keepIds = (() => {
                  try {
                    const p = payload_json as Record<string, unknown>;
                    const questions = Array.isArray(p.questions) ? (p.questions as Array<Record<string, unknown>>) : [];
                    const htmls: string[] = [];
                    for (const q of questions) {
                      if (typeof q.description_html === "string") htmls.push(q.description_html);
                      if (typeof q.answer_explanation_html === "string") htmls.push(q.answer_explanation_html);
                    }
                    const ids = new Set<string>();
                    for (const h of htmls) {
                      for (const id of extractInlineUploadIdsFromHtml(h)) ids.add(id);
                    }
                    return ids;
                  } catch {
                    return new Set<string>();
                  }
                })();

                const mergedInline = { ...(existing.inlineImages ?? {}), ...(inline_images ?? {}) };
                const nextInline: PendingLessonUploads["inlineImages"] = {};
                for (const [id, v] of Object.entries(mergedInline)) {
                  if (!keepIds.size || keepIds.has(id)) nextInline[id] = v;
                  else {
                    revokeObjectUrlSafe(v?.objectUrl);
                  }
                }
                return { ...prev, [localItemId]: { ...existing, inlineImages: nextInline } };
              });
            }
            toast.info("Quiz updated locally. Click Save Draft or Publish/Republish to apply changes.");
          }}
        />
      ) : itemModal ? (
        <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto">
          <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
            <div className="w-full max-w-4xl rounded-lg border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="font-semibold">Lesson</h3>
              <Button type="button" size="icon-sm" variant="ghost" onClick={cancelLessonModal}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-4 space-y-6 max-h-[75vh] overflow-auto">
              <>
                  <div>
                    <label className="text-sm font-medium">Lesson Name</label>
                    <Input
                      className="mt-1"
                      value={itemModal.lessonName}
                      onChange={(e) =>
                        setItemModal((prev) => (prev && prev.itemType === "lesson" ? { ...prev, lessonName: e.target.value } : prev))
                      }
                      placeholder="Draft Lesson"
                    />
                    <FieldHint>Name shown to learners in the curriculum once enrolled.</FieldHint>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Lesson Content</label>
                    <div className="mt-2 rounded-lg border bg-muted/10 p-4 space-y-3">
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onLessonBlocksDragEnd}>
                        <SortableContext
                          items={(itemModal.contentBlocks ?? []).map((b) => b.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          <div className="space-y-3">
                            {ensureAtLeastOneBlock(itemModal.contentBlocks ?? []).map((b, idx) => (
                              <SortableLessonContentBlockRow
                                key={b.id}
                                block={b}
                                index={idx}
                                queue={itemModal.inlineImages ?? {}}
                                setQueue={(updater) =>
                                  setItemModal((prev) => {
                                    if (!prev || prev.itemType !== "lesson") return prev;
                                    const next = typeof updater === "function" ? updater(prev.inlineImages ?? {}) : updater;
                                    return { ...prev, inlineImages: next ?? {} };
                                  })
                                }
                                onRemove={() => removeLessonContentBlock(b.id)}
                                onChangeHtml={(nextHtml) =>
                                  setItemModal((prev) => {
                                    if (!prev || prev.itemType !== "lesson") return prev;
                                    const blocks = ensureAtLeastOneBlock(prev.contentBlocks ?? []).map((x) =>
                                      x.id === b.id ? { ...x, html: nextHtml } : x
                                    );
                                    const nextInline = pruneQueueByBlocksWithRevoke(prev.inlineImages ?? {}, blocks);
                                    return { ...prev, contentBlocks: blocks, inlineImages: nextInline };
                                  })
                                }
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>

                      <div className="flex items-center justify-end">
                        <Button type="button" size="sm" onClick={addLessonContentBlock} className="gap-2">
                          <Plus className="h-4 w-4" />
                          Add New Content
                        </Button>
                      </div>
                    </div>
                    <FieldHint>
                      Add as many content blocks as you want. You can drag blocks to reorder, remove blocks, and use headings (H1–H6) inside each editor.
                    </FieldHint>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Feature Image</label>
                    <div className="mt-2 rounded-md border p-4 flex flex-col md:flex-row gap-4">
                      <div className="w-full md:w-[300px]">
                        {(() => {
                          const src =
                            itemModal.featureImagePreviewUrl ??
                            (itemModal.featureImageStoragePath
                              ? `/api/v2/lesson-assets?path=${encodeURIComponent(itemModal.featureImageStoragePath)}`
                              : null);

                          return (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            const el = document.getElementById("lesson-feature-image-input") as HTMLInputElement | null;
                            el?.click();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              const el = document.getElementById("lesson-feature-image-input") as HTMLInputElement | null;
                              el?.click();
                            }
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const f = e.dataTransfer.files?.[0] ?? null;
                            applyLessonFeatureImageFile(f);
                          }}
                          className={cn(
                            "relative h-[180px] cursor-pointer rounded-md border border-dashed flex items-center justify-center overflow-hidden bg-muted/10 transition-colors"
                          )}
                        >
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={src} alt="Lesson feature image preview" className="h-full w-full object-cover" />
                          ) : (
                            <div className="px-3 text-center">
                              <p className="text-xs text-muted-foreground">Drop or choose image</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">Click here or drag file into this area</p>
                            </div>
                          )}

                          {src ? (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Remove feature image"
                              title="Remove feature image"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                removeLessonFeatureImage();
                              }}
                              className="absolute right-2 top-2 bg-background/80 hover:bg-background text-destructive"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                          );
                        })()}
                        <Input
                          id="lesson-feature-image-input"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0] ?? null;
                            applyLessonFeatureImageFile(f);
                          }}
                        />
                      </div>
                      <div className="space-y-3">
                        <div className="text-sm text-muted-foreground">
                          <div>
                            <span className="font-medium text-foreground">Size:</span> 700×430 pixels
                          </div>
                          <div>
                            <span className="font-medium text-foreground">File support:</span> PNG, JPG, WebP
                          </div>
                          <div className="text-xs">Maximum upload size: 10MB</div>
                        </div>
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          onClick={() => (document.getElementById("lesson-feature-image-input") as HTMLInputElement | null)?.click()}
                          className="w-fit"
                        >
                          <Upload className="h-4 w-4" />
                          Upload Image
                        </Button>
                      </div>
                    </div>
                    <FieldHint>This image can be shown on the lesson header inside the learning experience.</FieldHint>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Video Source</label>
                    <div className="mt-2 space-y-3">
                      <select
                        className="h-10 w-full rounded-md border bg-transparent px-3 text-sm"
                        value={itemModal.videoProvider}
                        onChange={(e) =>
                          setItemModal((prev) =>
                            prev && prev.itemType === "lesson"
                              ? { ...prev, videoProvider: e.target.value as LessonVideoProvider, videoFile: null }
                              : prev
                          )
                        }
                      >
                        <option value="html5">HTML 5 (mp4)</option>
                        <option value="youtube">YouTube</option>
                        <option value="vimeo">Vimeo</option>
                      </select>

                      {itemModal.videoProvider === "html5" ? (
                        <div className="rounded-md border border-dashed border-primary bg-muted/10 p-10 text-center">
                          <p className="text-sm font-medium">Drag & Drop Your Video</p>
                          <p className="mt-1 text-xs text-muted-foreground">File format: .mp4 • Max size: 50MB</p>
                          <div className="mt-4">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => (document.getElementById("lesson-video-input") as HTMLInputElement | null)?.click()}
                            >
                              Browse file
                            </Button>
                          </div>
                          {itemModal.videoFile ? <p className="mt-3 text-xs text-muted-foreground">Selected: {itemModal.videoFile.name}</p> : null}
                          <Input
                            id="lesson-video-input"
                            type="file"
                            accept="video/mp4"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0] ?? null;
                              applyLessonVideoFile(f);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed border-primary bg-muted/10 p-4">
                          <Input
                            value={itemModal.videoUrl}
                            onChange={(e) =>
                              setItemModal((prev) => (prev && prev.itemType === "lesson" ? { ...prev, videoUrl: e.target.value } : prev))
                            }
                            placeholder={`Paste ${itemModal.videoProvider === "youtube" ? "YouTube" : "Vimeo"} video URL`}
                          />
                        </div>
                      )}
                    </div>
                    <FieldHint>Select video source for this lesson. External URLs must be full YouTube/Vimeo links.</FieldHint>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Video playback time</label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
                      <div>
                        <Input
                          type="number"
                          min={0}
                          max={999}
                          value={itemModal.playbackHours}
                          onChange={(e) =>
                            setItemModal((prev) =>
                              prev && prev.itemType === "lesson" ? { ...prev, playbackHours: Math.max(0, Number(e.target.value || 0)) } : prev
                            )
                          }
                          placeholder="Hours"
                        />
                        <FieldHint>Hours</FieldHint>
                      </div>
                      <div>
                        <Input
                          type="number"
                          min={0}
                          max={59}
                          value={itemModal.playbackMinutes}
                          onChange={(e) =>
                            setItemModal((prev) =>
                              prev && prev.itemType === "lesson"
                                ? { ...prev, playbackMinutes: Math.min(59, Math.max(0, Number(e.target.value || 0))) }
                                : prev
                            )
                          }
                          placeholder="Minutes"
                        />
                        <FieldHint>Minutes</FieldHint>
                      </div>
                    </div>
                    <FieldHint>Displayed to learners so they know how long the video takes.</FieldHint>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Upload exercise files to the Lesson</label>
                    <div className="mt-2 flex items-center gap-3">
                      <Input
                        id="lesson-attachments-input"
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (!files.length) return;
                          applyLessonAttachmentFiles(files);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => (document.getElementById("lesson-attachments-input") as HTMLInputElement | null)?.click()}
                      >
                        <Paperclip className="h-4 w-4" />
                        Upload Attachments
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {itemModal.attachments.length
                          ? `${itemModal.attachments.length} file(s) selected`
                          : itemModal.existingAttachments.length
                            ? `${itemModal.existingAttachments.length} existing file(s)`
                            : "No files selected"}
                      </p>
                    </div>
                    <FieldHint>Attach PDFs, worksheets, or other exercise materials for learners.</FieldHint>
                  </div>
              </>
            </div>
            <div className="flex items-center justify-between border-t px-4 py-3">
              <Button type="button" variant="outline" onClick={cancelLessonModal}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void saveLesson()} disabled={isBusy || itemModal.lessonName.trim().length < 2}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Update Lesson
              </Button>
            </div>
            </div>
          </div>
        </div>
      ) : null}

      {leavePrompt ? (
        <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto" data-leave-guard-ignore="true">
          <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
            <div className="w-full max-w-lg rounded-lg border bg-card shadow-xl">
              <div className="border-b px-4 py-3">
                <h3 className="font-semibold">Unsaved changes</h3>
              </div>
              <div className="p-4 space-y-2 text-sm text-muted-foreground">
                <p>You have unsaved changes in this course.</p>
                <p>Do you want to save before leaving this page?</p>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t px-4 py-3">
                <Button type="button" variant="outline" onClick={() => setLeavePrompt(null)}>
                  Cancel
                </Button>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const href = leavePrompt.href;
                      setLeavePrompt(null);
                      discardAllChanges();
                      router.push(href);
                    }}
                  >
                    Don’t save
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      const href = leavePrompt.href;
                      setLeavePrompt(null);
                      if (status === "published") {
                        void publishCourse({ afterSuccessNavigateTo: href });
                      } else {
                        void saveDraft({ afterSuccessNavigateTo: href });
                      }
                    }}
                  >
                    {status === "published" ? "Republish & leave" : "Save draft & leave"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmUnpublishDraftOpen ? (
        <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto" data-leave-guard-ignore="true">
          <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
            <div className="w-full max-w-lg rounded-lg border bg-card shadow-xl">
              <div className="border-b px-4 py-3">
                <h3 className="font-semibold">Save draft (unpublish)</h3>
              </div>
              <div className="p-4 space-y-2 text-sm text-muted-foreground">
                <p>
                  This course is currently <span className="font-medium text-foreground">Published</span>.
                </p>
                <p>
                  Clicking <span className="font-medium text-foreground">Save Draft</span> will{" "}
                  <span className="font-medium text-foreground">unpublish</span> the course and set it back to{" "}
                  <span className="font-medium text-foreground">Draft</span>.
                </p>
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900">
                  Learners will no longer be able to access this course until it is published again.
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 border-t px-4 py-3">
                <Button type="button" variant="outline" disabled={isBusy} onClick={() => setConfirmUnpublishDraftOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setConfirmUnpublishDraftOpen(false);
                    void saveDraft();
                  }}
                >
                  Unpublish &amp; save draft
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {successModal ? (
        <div className="fixed inset-0 z-1000 bg-black/50 p-4 sm:p-6 overflow-y-auto">
          <div className="min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-3rem)] flex items-center justify-center">
            <div className="w-full max-w-md rounded-lg border bg-card shadow-xl p-6 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-green-100 text-green-700 flex items-center justify-center mb-3">
              <Check className="h-6 w-6" />
            </div>
            <h3 className="text-lg font-semibold">{successModal.title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{successModal.description}</p>
            <div className="mt-4">
              <Button
                type="button"
                onClick={() => {
                  setSuccessModal(null);
                  toast.success(successModal.title);
                }}
              >
                OK
              </Button>
            </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


"use client";

import { useCallback } from "react";

import { RichTextEditor } from "@/features/courses/components/v2/RichTextEditor";
import type { InlineImageQueue } from "@/lib/richtext/inlineImages";

export function RichTextEditorWithUploads({
  value,
  onChange,
  placeholder,
  className,
  minHeightClass,
  queue,
  setQueue,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder: string;
  className?: string;
  minHeightClass?: string;
  queue: InlineImageQueue;
  setQueue: (next: InlineImageQueue | ((prev: InlineImageQueue) => InlineImageQueue)) => void;
}) {
  const onInlineImageQueued = useCallback(
    ({ uploadId, file, objectUrl }: { uploadId: string; file: File; objectUrl: string }) => {
      setQueue((prev) => ({ ...(prev ?? {}), [uploadId]: { file, objectUrl } }));
    },
    [setQueue]
  );

  return (
    <RichTextEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      minHeightClass={minHeightClass}
      onInlineImageQueued={onInlineImageQueued}
    />
  );
}


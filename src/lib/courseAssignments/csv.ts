import { accessKeyLabel, type AccessDurationKey, isAccessDurationKey } from "@/lib/courseAssignments/access";

export const COURSE_ASSIGNMENT_CSV_HEADERS = [
  "user_id",
  "email",
  "full_name",
  "course_id",
  "course_name",
  "assigned",
  "tfa",
] as const;

export type CourseAssignmentCsvHeader = (typeof COURSE_ASSIGNMENT_CSV_HEADERS)[number];

export type ParsedCourseAssignmentCsvRow = {
  rowNumber: number;
  user_id: string;
  email: string;
  full_name: string;
  course_id: string;
  course_title: string;
  assigned_raw: string;
  tfa_raw: string;
};

type CsvExportRow = {
  user_id: string;
  email: string;
  full_name: string;
  course_id: string;
  course_title: string;
  assigned: boolean;
  tfa: AccessDurationKey | "";
};

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function buildCourseAssignmentCsv(rows: CsvExportRow[]): string {
  const instructionLines = [
    "# Course assignment CSV template",
    "# Use one row per user for this course.",
    "# assigned: true = assign/update course access, false = remove course access.",
    "# tfa: allowed values are unlimited, 3m, 1m, 1w",
    "# course_id: do not change this value.",
    "# course_name: for admin reference only.",
    "",
  ];
  const headerLine = COURSE_ASSIGNMENT_CSV_HEADERS.map(csvEscape).join(",");
  const body = rows.map((row) =>
    [
      row.user_id,
      row.email,
      row.full_name,
      row.course_id,
      row.course_title,
      row.assigned ? "true" : "false",
      row.tfa,
    ]
      .map(csvEscape)
      .join(",")
  );
  return [...instructionLines, headerLine, ...body].join("\n") + "\n";
}

export function parseCourseAssignmentCsv(csvText: string): {
  rows: ParsedCourseAssignmentCsvRow[];
  error: string | null;
} {
  const normalized = csvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");

  const acceptedHeaders = [
    [...COURSE_ASSIGNMENT_CSV_HEADERS],
    ["user_id", "email", "full_name", "course_id", "course_title", "assigned", "tfa"],
  ];

  let headerLineIndex = -1;
  let headerCells: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    headerLineIndex = i;
    headerCells = splitCsvLine(trimmed).map((cell) => cell.toLowerCase());
    break;
  }

  if (headerLineIndex < 0) {
    return { rows: [], error: "CSV file is empty." };
  }

  const headersMatch = acceptedHeaders.some(
    (expected) => headerCells.length === expected.length && expected.every((header, idx) => headerCells[idx] === header)
  );
  if (!headersMatch) {
    return {
      rows: [],
      error: `Invalid CSV headers. Expected: ${COURSE_ASSIGNMENT_CSV_HEADERS.join(", ")}`,
    };
  }

  const rows: ParsedCourseAssignmentCsvRow[] = [];
  for (let i = headerLineIndex + 1; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const cells = splitCsvLine(trimmed);
    if (cells.length !== COURSE_ASSIGNMENT_CSV_HEADERS.length) {
      return { rows: [], error: `Invalid CSV format on row ${i + 1}. Expected ${COURSE_ASSIGNMENT_CSV_HEADERS.length} columns.` };
    }
    rows.push({
      rowNumber: i + 1,
      user_id: cells[0] ?? "",
      email: cells[1] ?? "",
      full_name: cells[2] ?? "",
      course_id: cells[3] ?? "",
      course_title: cells[4] ?? "",
      assigned_raw: cells[5] ?? "",
      tfa_raw: cells[6] ?? "",
    });
  }

  return { rows, error: null };
}

export function normalizeAssignedCell(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return null;
}

export function normalizeAccessCell(value: string): AccessDurationKey | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return isAccessDurationKey(normalized) ? normalized : null;
}

export function courseAssignmentCsvHelpText() {
  return ACCESS_KEY_HELP.map((row) => `${row.key} = ${row.label}`).join(", ");
}

const ACCESS_KEY_HELP = (["unlimited", "3m", "1m", "1w"] as AccessDurationKey[]).map((key) => ({
  key,
  label: accessKeyLabel(key),
}));

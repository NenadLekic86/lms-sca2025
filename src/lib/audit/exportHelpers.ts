export function roleLabel(role: string | null | undefined): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "system_admin":
      return "System Admin";
    case "organization_admin":
      return "Organization Admin";
    case "member":
      return "Member";
    default:
      return role ?? "";
  }
}

export function exportLabel(action: string | null | undefined): string {
  switch (action) {
    case "export_users":
      return "Users (CSV)";
    case "export_enrollments":
      return "Course progress / Enrollments (CSV)";
    case "export_certificates":
      return "Certificates (CSV)";
    case "export_courses":
      return "Courses (CSV)";
    case "export_organizations":
      return "Organizations (CSV)";
    default:
      return action ?? "Export";
  }
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function getMetaString(meta: Record<string, unknown> | null, key: string): string | null {
  const val = meta?.[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

export function getMetaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const val = meta?.[key];
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

export function getMetaBoolean(meta: Record<string, unknown> | null, key: string): boolean | null {
  const val = meta?.[key];
  return typeof val === "boolean" ? val : null;
}


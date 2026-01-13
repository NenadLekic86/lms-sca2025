import type { Role } from "@/types";

export function roleLabel(role: Role): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "system_admin":
      return "System Admin";
    case "organization_admin":
      return "Organization Admin";
    case "member":
      return "Member";
    default: {
      // Exhaustiveness guard for future roles
      return String(role);
    }
  }
}



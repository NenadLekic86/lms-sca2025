import { UserTable } from "@/features/users";

export default function SystemAdminsPage() {
  // Uses the existing Users API and filters to role=system_admin (server still enforces permissions).
  return (
    <div className="container mx-auto p-6">
      <UserTable
        title="System Admins"
        filterRole="system_admin"
        inviteRolesOverride={["system_admin"]}
      />
    </div>
  );
}


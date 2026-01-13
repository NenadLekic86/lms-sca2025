import { UserTable } from "@/features/users";

export default function SystemOrgAdminsPage() {
  return (
    <div className="container mx-auto p-6">
      <OrganizationAdminsTable />
    </div>
  );
}

function OrganizationAdminsTable() {
  return (
    <UserTable
      title="Organization Admins"
      filterRole="organization_admin"
      inviteRolesOverride={["organization_admin"]}
    />
  );
}


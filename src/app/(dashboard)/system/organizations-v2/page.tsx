import { OrganizationsTableV2 } from "@/features/organizations";

export default function SystemOrganizationsV2Page() {
  return (
    <div className="container mx-auto">
      <OrganizationsTableV2 title="Organizations" subtitle="Manage all organizations in the system" />
    </div>
  );
}


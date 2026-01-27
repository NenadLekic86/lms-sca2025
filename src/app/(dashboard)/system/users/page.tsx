import { UserTableV2 } from "@/features/users";

export default function SystemUsersPage() {
  return (
    <div className="container mx-auto">
      <UserTableV2 title="All Users" />
    </div>
  );
}



import { UserTable } from "@/features/users";

export default function SystemUsersPage() {
  return (
    <div className="container mx-auto p-6">
      <UserTable title="All Users" />
    </div>
  );
}



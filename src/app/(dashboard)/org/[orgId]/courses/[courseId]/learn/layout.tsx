export default function CourseLearnLayout({ children }: { children: React.ReactNode }) {
  // DashboardLayout uses `p-6` on the main scroll container.
  // For the learning flow we want: pt-6 pr-6 pl-0 pb-0.
  // This wrapper cancels the left + bottom padding only.
  return <div className="-ml-6 -mb-6">{children}</div>;
}


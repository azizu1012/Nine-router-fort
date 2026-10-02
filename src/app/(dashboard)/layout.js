import { DashboardLayout } from "@/shared/components";
import DashboardCacheInvalidator from "./DashboardCacheInvalidator";

export default function DashboardRootLayout({ children }) {
  return (
    <>
      <DashboardCacheInvalidator />
      <DashboardLayout>{children}</DashboardLayout>
    </>
  );
}

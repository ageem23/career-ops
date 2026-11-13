import { ScheduledJobsView } from "@/components/scheduled-jobs-view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Scheduled scans" };

export default function ScheduledScansPage() {
  return <ScheduledJobsView />;
}

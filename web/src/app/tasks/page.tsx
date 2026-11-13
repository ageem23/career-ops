import { TasksView } from "@/components/tasks/tasks-view";
import { readTasks } from "@/lib/tasks-server";
import { localISODate } from "@/lib/followups";

export const dynamic = "force-dynamic"; // data/tasks.md is read fresh per request

export const metadata = { title: "Tasks" };

export default function TasksPage() {
  return <TasksView tasks={readTasks()} today={localISODate()} />;
}

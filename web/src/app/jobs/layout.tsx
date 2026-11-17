// The pages are client components, so their tab title lives here. A single
// worker page replaces it with the worker's company once the job loads.
export const metadata = { title: "Jobs" };

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

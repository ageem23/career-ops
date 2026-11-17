import { CvStudio } from "@/components/cv-studio/cv-studio";
import { applicationMetadata } from "@/lib/tab-title-server";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return applicationMetadata(params, "CV Studio");
}

export default async function CvStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CvStudio n={id} claudeCwd={resolveCodeRoot(process.cwd(), process.env)} />;
}

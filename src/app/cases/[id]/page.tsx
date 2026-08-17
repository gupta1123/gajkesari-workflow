import { CaseDetailPage } from "@/components/cases/CaseDetailPage";

export default async function SavedCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <CaseDetailPage caseId={id} />;
}

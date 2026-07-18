import { CaseMismatchPage } from "@/components/cases/CaseMismatchPage";

export default async function SavedCaseMismatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <CaseMismatchPage caseId={id} />;
}

import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/tally-prime?view=connection");
}


import { Dashboard } from "@/components/dashboard/dashboard";
import { SessionGuard } from "@/components/auth/session-guard";
import { getVerifiedUser } from "@/lib/auth/user";
import { redirect } from "next/navigation";
import { loadWorkspace } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams?: Promise<{ date?: string | string[] }> }) {
  const user = await getVerifiedUser();
  if (!user) redirect("/login");
  const workspace = await loadWorkspace(user.id, (await searchParams)?.date);
  if (workspace.kind === "signed-out") redirect("/login");
  return <SessionGuard key={user.id} userId={user.id}><Dashboard workspace={workspace} /></SessionGuard>;
}

import { Dashboard } from "@/components/dashboard/dashboard";
import { SessionGuard } from "@/components/auth/session-guard";
import { getVerifiedUser } from "@/lib/auth/user";
import { redirect } from "next/navigation";
import { loadWorkspace } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams?: Promise<{ date?: string | string[]; calendar?: string | string[] }> }) {
  const user = await getVerifiedUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const workspace = await loadWorkspace(user.id, params?.date);
  if (workspace.kind === "signed-out") redirect("/login");
  const calendarNotice = typeof params?.calendar === "string" ? params.calendar : undefined;
  return <SessionGuard key={user.id} userId={user.id}><Dashboard workspace={workspace} calendarNotice={calendarNotice} /></SessionGuard>;
}

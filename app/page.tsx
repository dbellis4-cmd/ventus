import { Dashboard } from "@/components/dashboard/dashboard";
import { SessionGuard } from "@/components/auth/session-guard";
import { getVerifiedUser } from "@/lib/auth/user";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getVerifiedUser();
  if (!user) redirect("/login");
  return <SessionGuard userId={user.id}><Dashboard /></SessionGuard>;
}

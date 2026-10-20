import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { getVerifiedUser } from "@/lib/auth/user";

const notices: Record<string, string> = {
  "password-updated": "Your password has been updated. Log in with your new password.",
  "signed-out": "You have been signed out.",
  "session-expired": "Your session has ended. Please log in again.",
  "link-error": "This link is incomplete or could not be verified. Request a new link and try again.",
  "link-verifier-missing": "This link needs the browser and site address where you requested it. Return to that browser, request a new link, and open the newest email.",
  "link-expired": "This link has expired or was already used. Request a new link and open the newest email.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  if (await getVerifiedUser()) redirect("/");
  const { notice } = await searchParams;
  return <AuthForm mode="login" notice={notice && Object.hasOwn(notices, notice) ? notices[notice] : undefined} />;
}

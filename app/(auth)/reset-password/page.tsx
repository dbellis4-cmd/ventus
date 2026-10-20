import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { getVerifiedUser } from "@/lib/auth/user";

export default async function ResetPasswordPage() {
  if (!await getVerifiedUser()) redirect("/forgot-password?notice=expired");
  return <AuthForm mode="reset" />;
}

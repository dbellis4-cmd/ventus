import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { getVerifiedUser } from "@/lib/auth/user";

export default async function SignupPage() {
  if (await getVerifiedUser()) redirect("/");
  return <AuthForm mode="signup" />;
}

import { AuthForm } from "@/components/auth/auth-form";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  return <AuthForm mode="recovery" notice={notice === "expired" ? "Your recovery session has expired. Request a new reset link." : undefined} />;
}

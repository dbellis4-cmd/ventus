import { getVerifiedUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getVerifiedUser();
  return Response.json({ userId: user?.id ?? null }, {
    status: user ? 200 : 401,
    headers: { "Cache-Control": "private, no-store" },
  });
}

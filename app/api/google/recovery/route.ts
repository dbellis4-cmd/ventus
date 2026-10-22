import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/google/server";
import { syncOwner } from "@/lib/google/sync";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse(null, { status: 401 });
  }
  const db = serviceClient();
  const { data, error } = await db.rpc("google_calendar_due_owners", { p_limit: 10 });
  if (error) return new NextResponse(null, { status: 503 });
  for (const owner of data ?? []) await syncOwner(owner);
  return NextResponse.json({ processedOwners: data?.length ?? 0 }, { headers: { "Cache-Control": "no-store" } });
}

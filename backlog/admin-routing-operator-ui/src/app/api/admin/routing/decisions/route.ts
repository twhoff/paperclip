import { NextResponse } from "next/server";
import { requirePlatformAdminSession } from "@/lib/session";
import { getAgentSummaries } from "@/lib/services/routing-decisions.service";

export const dynamic = "force-dynamic";

/** GET /api/admin/routing/decisions — all-agent summary for the default view */
export async function GET() {
  const sessionOrResponse = await requirePlatformAdminSession();
  if (sessionOrResponse instanceof Response) return sessionOrResponse;

  try {
    const summaries = await getAgentSummaries();
    return NextResponse.json(summaries);
  } catch {
    return NextResponse.json({ error: "Failed to load routing decisions" }, { status: 500 });
  }
}

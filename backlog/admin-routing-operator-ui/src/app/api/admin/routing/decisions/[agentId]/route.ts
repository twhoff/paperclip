import { NextResponse } from "next/server";
import { requirePlatformAdminSession } from "@/lib/session";
import { getAgentTimeline } from "@/lib/services/routing-decisions.service";

export const dynamic = "force-dynamic";

/** GET /api/admin/routing/decisions/[agentId] — full timeline for one agent */
export async function GET(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const sessionOrResponse = await requirePlatformAdminSession();
  if (sessionOrResponse instanceof Response) return sessionOrResponse;

  const { agentId } = await params;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

  try {
    const timeline = await getAgentTimeline(agentId);
    return NextResponse.json(timeline);
  } catch {
    return NextResponse.json({ error: "Failed to load agent timeline" }, { status: 500 });
  }
}

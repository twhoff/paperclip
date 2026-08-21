import { NextResponse } from "next/server";
import { requirePlatformAdminSession } from "@/lib/session";
import { getEvaluationScores } from "@/lib/services/routing-decisions.service";

export const dynamic = "force-dynamic";

/** GET /api/admin/routing/decisions/[agentId]/evaluation/[evaluationId] — candidate scores */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string; evaluationId: string }> }
) {
  const sessionOrResponse = await requirePlatformAdminSession();
  if (sessionOrResponse instanceof Response) return sessionOrResponse;

  const { evaluationId } = await params;
  const evalId = parseInt(evaluationId, 10);
  if (isNaN(evalId)) {
    return NextResponse.json({ error: "Invalid evaluationId" }, { status: 400 });
  }

  try {
    const breakdown = await getEvaluationScores(evalId);
    if (!breakdown) {
      return NextResponse.json({ error: "Evaluation not found" }, { status: 404 });
    }
    return NextResponse.json(breakdown);
  } catch {
    return NextResponse.json({ error: "Failed to load candidate scores" }, { status: 500 });
  }
}

import { getCounts } from "../../../lib/db.js";

/** Headline per-carrier availability. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await getCounts();
    return Response.json(counts, {
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
    });
  } catch (err) {
    console.error("counts route failed", err);
    return Response.json({ error: "query failed" }, { status: 502 });
  }
}

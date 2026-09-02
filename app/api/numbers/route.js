import { getNumbers } from "../../../lib/db.js";

/**
 * A page of numbers for the interactive browser.
 *
 * The client sends filter/sort/paging params; `buildQuery` validates them and rejects
 * anything unrecognised, so no request input reaches the SQL text. Runs on the server,
 * where DATABASE_URL lives.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  try {
    const { rows, total } = await getNumbers(params);
    return Response.json(
      { rows, total },
      { headers: { "cache-control": "public, max-age=15, stale-while-revalidate=60" } }
    );
  } catch (err) {
    // "unknown carrier"/"unknown sort" are the caller's fault; anything else is ours.
    const bad = /^unknown /.test(err.message || "");
    if (!bad) console.error("numbers route failed", err);
    return Response.json({ error: bad ? err.message : "query failed" }, { status: bad ? 400 : 502 });
  }
}

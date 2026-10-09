import { NextResponse } from "next/server";
import { migrationsDone } from "../../../../lib/db";

/** Ready only once boot migrations have completed — before that, every
 *  request would fail with "relation does not exist" anyway. */
export async function GET(): Promise<Response> {
  if (!migrationsDone()) {
    return NextResponse.json({ status: "migrating" }, { status: 503 });
  }
  return NextResponse.json({ status: "ready" });
}

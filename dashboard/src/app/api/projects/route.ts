import { NextRequest, NextResponse } from "next/server";

/**
 * /api/projects — deprecated alias for /api/initiatives
 *
 * No frontend references remain. Redirect any stray callers to the
 * canonical initiatives endpoint.
 */

export function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/initiatives";
  return NextResponse.redirect(url, 308);
}

export function POST(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/initiatives";
  return NextResponse.redirect(url, 308);
}

export function PATCH(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/api/initiatives";
  return NextResponse.redirect(url, 308);
}

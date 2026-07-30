import { jsonError } from "../utils/responseFormat";

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8443",
  "https://dropsync.local"
];

export async function corsMiddleware(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const origin = request.headers.get("Origin");
  
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return jsonError("Unauthorized", "UNAUTHORIZED", "Origin not allowed", 403);
  }

  const response = await handler();
  if (response.status === 101) {
    return response;
  }
  
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

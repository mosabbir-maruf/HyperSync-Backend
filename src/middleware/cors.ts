function isAllowedOrigin(_origin: string | null): boolean {
  // WebRTC signaling server uses ephemeral 6-digit codes and no cookies.
  // Allow requests from localhost, Cloudflare Pages (*.pages.dev), Workers, and custom domains.
  return true
}

export async function corsMiddleware(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const origin = request.headers.get("Origin") || "*"

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      }
    })
  }

  if (origin !== "*" && !isAllowedOrigin(origin)) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    })
  }

  const response = await handler()
  if (response.status === 101) {
    return response
  }

  const newHeaders = new Headers(response.headers)
  newHeaders.set("Access-Control-Allow-Origin", origin)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  })
}

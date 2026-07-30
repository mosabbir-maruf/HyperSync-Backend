export function jsonSuccess(data: unknown, status: number = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({
    success: true,
    data,
    timestamp: Date.now()
  }), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

export function jsonError(error: string, code: string, message: string, status: number = 400, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({
    success: false,
    error,
    code,
    message,
    timestamp: Date.now()
  }), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

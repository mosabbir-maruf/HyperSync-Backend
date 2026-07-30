import { BaseError } from "../types/errors";
import { jsonError } from "../utils/responseFormat";

export async function withErrorHandler(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof BaseError) {
      return jsonError(error.name, error.name.toUpperCase(), error.message, error.status);
    }
    console.error("Unhandled Error:", error);
    return jsonError("InternalError", "INTERNAL_ERROR", "Internal Server Error", 500);
  }
}

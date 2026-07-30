import { Router } from "./routes/router";
import { SignalingRoom } from "./durable/SignalingRoom";

export interface Env {
	SIGNALING_ROOM: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const router = new Router(env);
    return router.route(request);
	},
};

export { SignalingRoom };

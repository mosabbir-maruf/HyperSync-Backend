import { Router } from "./routes/router";
import { SignalingRoom } from "./durable/SignalingRoom";
import { LobbyRoom } from "./durable/LobbyRoom";
import { GroupSignalingRoom } from "./durable/GroupSignalingRoom";

export interface Env {
	SIGNALING_ROOM: DurableObjectNamespace;
	LOBBY_ROOM: DurableObjectNamespace;
	GROUP_SIGNALING_ROOM: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const router = new Router(env);
    return router.route(request);
	},
};

export { SignalingRoom, LobbyRoom, GroupSignalingRoom };

import { getWebsocketController, WebsocketController } from '../websocket/controllers';
import type { WebsocketClient, WebsocketMessage } from '../websocket/types';
import { stringify } from '../websocket/utils/message';
import emitter from '../emitter';
import type { ActionHandler } from '@directus/shared/types';

export class WebsocketService {
	private controller: WebsocketController;

	constructor() {
		this.controller = getWebsocketController();
	}

	on(event: 'connect' | 'message' | 'error' | 'close', callback: ActionHandler) {
		emitter.onAction('websocket.' + event, callback);
	}
	off(event: 'connect' | 'message' | 'error' | 'close', callback: ActionHandler) {
		emitter.offAction('websocket.' + event, callback);
	}

	broadcast(message: string | WebsocketMessage, filter?: { user?: string; role?: string }) {
		this.controller.clients.forEach((client: WebsocketClient) => {
			if (filter && filter.user && filter.user !== client.accountability.user) return;
			if (filter && filter.role && filter.role !== client.accountability.role) return;
			client.send(typeof message === 'string' ? message : stringify(message));
		});
	}
	clients(): Set<WebsocketClient> {
		return this.controller.clients;
	}
}

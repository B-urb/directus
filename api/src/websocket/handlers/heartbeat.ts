import emitter from '../../emitter';
import { fmtMessage, trimUpper } from '../utils/message';
import { WebsocketClient, WebsocketMessage } from '../types';
import { WebsocketController, getWebsocketController } from '../controllers';
import { ActionHandler } from '@directus/shared/types';
import logger from '../../logger';
import env from '../../env';

const HEARTBEAT_FREQUENCY = Number(env.WEBSOCKETS_HEARTBEAT_FREQUENCY) * 1000;

export class HeartbeatHandler {
	private pulse: NodeJS.Timer | undefined;
	private controller: WebsocketController;

	constructor() {
		this.controller = getWebsocketController();
		emitter.onAction('websocket.message', ({ client, message }) => {
			this.onMessage(client, message);
		});
		emitter.onAction('websocket.connect', () => this.checkClients());
		emitter.onAction('websocket.error', () => this.checkClients());
		emitter.onAction('websocket.close', () => this.checkClients());
	}
	private checkClients() {
		const hasClients = this.controller.clients.size > 0;
		logger.debug('checkClients', hasClients, !this.pulse);
		if (hasClients && !this.pulse) {
			this.pulse = setInterval(() => {
				this.pingClients();
			}, HEARTBEAT_FREQUENCY);
		}
		if (!hasClients && this.pulse) {
			clearInterval(this.pulse);
			this.pulse = undefined; // do we need this?
		}
	}
	onMessage(client: WebsocketClient, message: WebsocketMessage) {
		if (trimUpper(message.type) !== 'PING') return;
		// send pong message back as acknowledgement
		client.send(fmtMessage('pong', message.uid ? { uid: message.uid } : {}));
	}
	pingClients() {
		const pendingClients = new Set<WebsocketClient>(this.controller.clients);
		const activeClients = new Set<WebsocketClient>();
		const timeout = setTimeout(() => {
			// close connections that havent responded
			for (const client of pendingClients) {
				client.close();
			}
		}, HEARTBEAT_FREQUENCY);
		const messageWatcher: ActionHandler = ({ client }) => {
			// any message means this connection is still open
			if (!activeClients.has(client)) {
				pendingClients.delete(client);
				activeClients.add(client);
			}
			if (pendingClients.size === 0) {
				clearTimeout(timeout);
				emitter.offAction('websocket.message', messageWatcher);
			}
		};
		emitter.onAction('websocket.message', messageWatcher);
		// ping all the clients
		for (const client of pendingClients) {
			client.send(fmtMessage('ping'));
		}
	}
}

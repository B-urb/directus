import { getSchema } from '../../utils/get-schema';
import { ItemsService } from '../../services/items';
import { SubscriptionMap, WebsocketClient, WebsocketMessage } from '../types';
import { Query } from '@directus/shared/types';
import emitter from '../../emitter';
import logger from '../../logger';
import { refreshAccountability } from '../utils/refresh-accountability';
import { errorMessage, trimUpper } from '../utils/message';

export class SubscribeHandler {
	subscriptions: SubscriptionMap;

	constructor() {
		this.subscriptions = {};
		this.bindWebsocket();
		this.bindModules([
			'items' /*, 'activity', 'collections', 'fields', 'folders', 'permissions',
			'presets', 'relations', 'revisions', 'roles', 'settings', 'users', 'webhooks'*/,
		]);
	}
	bindWebsocket() {
		emitter.onAction('websocket.message', ({ client, message }) => {
			try {
				this.onMessage(client, message);
			} catch (err) {
				return client.send(errorMessage(err));
			}
		});
		emitter.onAction('websocket.error', ({ client }) => this.unsubscribe(client));
		emitter.onAction('websocket.close', ({ client }) => this.unsubscribe(client));
	}
	bindModules(modules: string[]) {
		const bindAction = (event: string, mutator?: (args: any) => any) => {
			emitter.onAction(event, async (args: any) => {
				const message = mutator ? mutator(args) : {};
				message.action = event.split('.').pop();
				message.collection = args.collection;
				message.payload = args.payload;
				logger.debug(`[ WS ] event ${event} ` /*- ${JSON.stringify(message)}`*/);
				this.dispatch(message.collection, message);
			});
		};
		for (const module of modules) {
			bindAction(module + '.create', ({ key }: any) => ({ key }));
			bindAction(module + '.update', ({ keys }: any) => ({ keys }));
			bindAction(module + '.delete');
		}
	}
	subscribe(collection: string, client: WebsocketClient, conf: { query?: Query } = {}) {
		if (!this.subscriptions[collection]) this.subscriptions[collection] = new Set();
		this.subscriptions[collection]?.add({ ...conf, client });
	}
	unsubscribe(client: WebsocketClient) {
		for (const key of Object.keys(this.subscriptions)) {
			const subscriptions = Array.from(this.subscriptions[key] || []);
			for (let i = subscriptions.length - 1; i >= 0; i--) {
				const subscription = subscriptions[i];
				if (!subscription) continue;
				if (subscription.client === client) {
					this.subscriptions[key]?.delete(subscription);
				}
			}
		}
	}
	async dispatch(collection: string, data: any) {
		const subscriptions = this.subscriptions[collection] ?? new Set();
		for (const { client, query = {} } of subscriptions) {
			client.accountability = await refreshAccountability(client.accountability);
			const service = new ItemsService(collection, {
				schema: await getSchema({ accountability: client.accountability }),
				accountability: client.accountability,
			});
			try {
				// get the payload based on the provided query
				const keys = data.key ? [data.key] : data.keys;
				const payload = data.action !== 'delete' ? await service.readMany(keys, query) : data.payload;
				if (payload.length > 0) {
					client.send(JSON.stringify({ payload: 'key' in data ? payload[0] : payload }));
				}
			} catch (err: any) {
				logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
	}
	async onMessage(client: WebsocketClient, message: WebsocketMessage) {
		if (!['SUBSCRIBE', 'UNSUBSCRIBE'].includes(trimUpper(message.type))) return;
		const collection = message.collection!;
		logger.debug(`[WS REST] SubscribeHandler ${JSON.stringify(message)}`);
		const service = new ItemsService(collection, {
			schema: await getSchema(),
			accountability: client.accountability,
		});
		try {
			// if not authorized the read should throw an error
			await service.readByQuery({ ...(message.query || {}), limit: 1 });
			// subscribe to events if all went well
			this.subscribe(collection, client, { query: message.query });
		} catch (err: any) {
			logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
		}
	}
}

/**
 * In-process event bus for decoupled domain events, designed for replacement
 * by durable Redis/BullMQ infrastructure in Phase 2.
 *
 * NOTE: As an in-process EventEmitter, events are held in Node.js memory.
 * Durable delivery, queue persistence, and dead-letter handling will be introduced in Phase 2 with Redis / BullMQ.
 *
 * Usage:
 *   import eventBus from '../notifications/eventBus.js';
 *   eventBus.emit('issue.created', { issue, actor, project });
 *   eventBus.on('issue.created', handler);
 */

import { EventEmitter } from 'node:events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

export default eventBus;

/**
 * Transactional outbox.
 *
 * The only correct way to "fire an event when a state change commits" is to
 * write the event in the SAME transaction as the change. emitEvent does
 * exactly that against a caller-supplied transaction client; the outbox
 * poller (see queue/workers.js) later turns pending rows into durable BullMQ
 * jobs. If the transaction rolls back, the event vanishes with it — no
 * webhook ever fires for a change that did not happen, and a committed change
 * can never lose its event to a crash.
 */

const { withTransaction } = require('../db');

/**
 * Insert an outbox event using the given transaction client.
 * @param {object} client  a pg client already inside BEGIN (from withTransaction)
 * @param {object} evt
 * @param {string} [evt.aggregateType]  e.g. 'file'
 * @param {string} [evt.aggregateId]
 * @param {string} evt.eventType        e.g. 'file.uploaded'
 * @param {object} evt.payload          JSON-serializable event body
 * @returns {Promise<object>} the inserted row
 */
async function emitEvent(client, { aggregateType = null, aggregateId = null, eventType, payload }) {
  if (!eventType) throw new Error('emitEvent requires an eventType');
  const { rows } = await client.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload == null ? {} : payload)]
  );
  return rows[0];
}

/**
 * Convenience for callers not already inside a transaction: opens its own
 * transaction just to persist the event durably. Use emitEvent instead when
 * the event must be atomic with another state change.
 */
async function emitEventStandalone(evt) {
  return withTransaction((client) => emitEvent(client, evt));
}

module.exports = { emitEvent, emitEventStandalone };

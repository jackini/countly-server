'use strict';

var EventEmitter = require('events').EventEmitter,
	cluster = require('cluster'),
	LRU = require('lru-cache'),
	util = require('util'),
	merge = require('merge'),
	constants = require('./constants'),
	EVENTS = constants.EVENTS,
	DEFAULTS = constants.OPTIONS,
	log = require('../../../../../api/utils/log.js')('push:master'),
	M = require('./message'),
	_ = require('lodash');

var WorkerWrapper = function(worker, master){
	this.options = master.options;

	this.worker = worker;
	this.pid = worker.process.pid;
	this.mid = process.pid;

	// map {cred.id(): 1} of should-be-open connections (can actually be already interrupted by APNS, but we don't care about that)
	this.connections = LRU({max: this.options.connections, maxAge: this.options.connectionTTL});

	// queue length (messages quantity, not devices quantity)
	this.queueLength = 0;

	this.send = function(cmd) {
		cmd.pid = this.pid;
		cmd.mid = this.mid;
		log.d('Sending IPC from master %d to worker %d: %j', process.pid, this.pid, cmd);
		this.worker.send(cmd);
	};

	worker.on('message', function(m){
		if (typeof this[m.cmd] === 'function') {
			log.d('IPC message from %s: %j', m.pid, m);
			this[m.cmd](m);
		}
	}.bind(master));
};

WorkerWrapper.prototype.price = function(message) {
	return (this.connections.get(message.credentialsId()) ? 0 : this.options.priceOfConnection) + this.options.priceOfQueue * this.queueLength;
};

var Master = function(opts) {
	this.options = merge({}, DEFAULTS, opts);

	// Array of WorkerWrapper objects
	this.workers = [];

	// Map of messages in processing: {message.id: message}
	this.messages = {};

	// Map of tasks processors: {message.id: worker}
	this.tasks = {};

	// Map of tasks initiators: {message.id: worker}
	this.tasksInitiators = {};

	// Map of tasks clean up refs: {message.id: setTimeout ref}
	this.cleanUps = {};

	cluster.on('online', function(worker){
		this.workers.push(new WorkerWrapper(worker, this));
	}.bind(this));

	cluster.on('exit', function(worker){
		log.e('Worker crashed: %d', worker.process.pid);
		_.remove(this.workers, {id: worker.pid});
	}.bind(this));

	process.on('uncaughtException', function(err){
		log.e('uncaughtException on process: %j', err.stack);
	}.bind(this));

    log.i('Master started %d', process.pid);
};

util.inherits(Master, EventEmitter);

Master.prototype.push = function(message) {
	log.d('Pushing new message %j from master', message.id);
	this[EVENTS.MASTER_SEND]({
		cmd: EVENTS.MASTER_SEND,
		message: message.serialize()
	});
};

Master.prototype.abort = function(message) {
	log.d('Aborting message %j from master', message.id);
	this[EVENTS.MASTER_ABORT]({
		cmd: EVENTS.MASTER_ABORT,
		message: message.serialize()
	});
};

/**
 * Find process with the least queue length.
 * @api private
 */
Master.prototype.workerWithMinimalPrice = function(message) {
	var prices = _.invoke(this.workers, 'price', message),
		min = _.min(prices);
	return this.workers[prices.indexOf(min)];
};

/**
 * Select a worker with connection open or least loaded worker and dispatch message to it.
 * @api private
 */
Master.prototype[EVENTS.MASTER_SEND] = function(m) {
	var message = new M.Message(m.message),
		mid = message.id,
		cid = message.credentialsId(),
		worker = this.workerWithMinimalPrice(message);

	worker.queueLength++;
	worker.connections.set(cid, 1);

	this.tasks[mid] = worker;
	if (m.pid) {
		this.tasksInitiators[mid] = _.find(this.workers, {pid: m.pid});
	} else {
		// sending from self
	}

	process.nextTick(function(){
		this.update(message, {status: M.Status.InQueue});
	}.bind(this));

	worker.send({
		cmd: EVENTS.CHILD_PROCESS,
		message: m.message,
	});
};

/**
 * Abort message sending.
 * @api private
 */
Master.prototype[EVENTS.MASTER_ABORT] = function(m) {
	var worker = this.tasks[m.messageId];

	if (worker) {
		worker.send({
			cmd: EVENTS.CHILD_ABORT,
			messageId: m.messageId
		});
		this.cleanupFromMessageId(m.messageId);
	}
};

/**
 * Update message status
 * @api private
 */
Master.prototype[EVENTS.MASTER_STATUS] = function(m) {
	var message = this.messages[m.messageId];
	if (message) {
		this.update(message, m.result);
	}
};

/**
 * Change logging level
 * @api private
 */
Master.prototype[EVENTS.MASTER_SET_LOGGING] = function(m) {
	constants.setDebugEnabled(null, m.enable);
	this.workers.forEach(function(w){
		w.send({
			cmd: EVENTS.CHILD_SET_LOGGING,
			enable: m.enable
		});
	});
};

/**
 * Remove message from private variables after 20 seconds delay (some device tokens might be not processed yet)
 * @api private
 */
Master.prototype.cleanupFromMessageId = function(messageId) {
	if (!(messageId in this.cleanUps)) {
		this.cleanUps[messageId] = setTimeout(function(){
			log.d('Cleaning up message %j from master', messageId);
		    delete this.messages[messageId];
		    delete this.tasks[messageId];
		    delete this.tasksInitiators[messageId];
		    delete this.cleanUps[messageId];
		}.bind(this), 30000);
	}
};

/**
 * Update message internally and emit 'status' event
 * @api private
 */
Master.prototype.update = function(message, update) {
	merge(message.result, update);
	this.messages[message.id] = message;

	if ((update.status & (M.Status.Aborted | M.Status.Done)) > 0) {
		this.cleanupFromMessageId(message.id);
	}

	if (message.id in this.tasksInitiators) {
		log.d('Emiting status on initiator worker: %j, %j', message.id, update);
		this.tasksInitiators[message.id].send(merge({
			cmd: EVENTS.CHILD_STATUS,
			messageId: message.id,
			result: update,
		}, update));
	} else {
		log.d('Emiting status on master');
		this.emit('status', message);
	}
};

Master.prototype.setLoggingEnabled = function(enabled) {
	constants.setDebugEnabled(null, enabled);
	this[EVENTS.MASTER_SET_LOGGING]({enable: enabled});
};

// Master.prototype.log = function() {
// 	log.d.apply(log, arguments);
// };

module.exports = Master;

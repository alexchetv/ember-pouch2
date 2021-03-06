import Ember from 'ember';
import DS from 'ember-data';

import {
  extractDeleteRecord
} from 'ember-pouch/utils';

const {
  run: {
    bind
  },
  on,
  String: {
    pluralize,
    camelize,
    classify
  }
} = Ember;

export default DS.RESTAdapter.extend(Ember.Evented, {
  coalesceFindRequests: true,

  // The change listener ensures that individual records are kept up to date
  // when the data in the database changes. This makes ember-data 2.0's record
  // reloading redundant.
	shouldReloadAll: function() { return true; },
	shouldBackgroundReloadAll: function() { return true; },
  shouldReloadRecord: function () { return true; },
  shouldBackgroundReloadRecord: function () { return true; },

	startReplication: function (live_retry = true) {
		console.log('START REPLICATION');
		this.replicateTo = this.get('db').replicate.to(this.get('remote'),{
			live: live_retry,
			retry: live_retry
		}).on('change', bind(this, 'onToChange'))
			.on('paused', bind(this, 'onPaused'))
			.on('active', bind(this, 'onActive'))
			.on('denied', bind(this, 'onDenied'))
			.on('complete', bind(this, 'onComplete'))
			.on('error', bind(this, 'onError'));

		this.replicateFrom = this.get('db').replicate.from(this.get('remote'),{
			live: live_retry,
			retry: live_retry
		}).on('change', bind(this, 'onFromChange'))
			.on('paused', bind(this, 'onPaused'))
			.on('active', bind(this, 'onActive'))
			.on('denied', bind(this, 'onDenied'))
			.on('complete', bind(this, 'onComplete'))
			.on('error', bind(this, 'onError'));
	},
	stopReplication: function () {
		console.log('STOP REPLICATION');
		this.replicateTo.cancel();
		this.replicateFrom.cancel();
	},
  onFromChange: function (change) {
	  console.log('onFromChange',change.docs);
	  var self = this;
	  change.docs.forEach(function (doc) {
		  var obj = self.get('db').rel.parseDocID(doc._id);
		  // skip changes for non-relational_pouch docs. E.g., design docs.
		  if (!obj.type || obj.type === '') { return; }
		  console.log('doc',doc);
		  if (doc._deleted) {
			  var record = self.get('store').peekRecord(obj.type,obj.id);
			  if (record && !record.get("isDeleted")) {
				  record.unloadRecord();
			  }
		  } else {
			  console.log('findTodo');
			  self.get('store').findRecord(obj.type,obj.id);
		  }
	  });
  },
	onToChange: function (change) {
		console.log('onToChange',change);
	},
	onError: function (err) {
		console.log('onError');
		this.trigger('ReplicationError',{"err":err});
	},
	onPaused: function () {
		console.log('onPaused');
		this.trigger('ReplicationPaused');
	},
	onActive: function () {
		console.log('onActive');
		this.trigger('ReplicationActive');
	},
	onDenied: function (err) {
		console.log('onDenied');
		this.trigger('ReplicationDenied',{"err":err});
	},
	onComplete: function (info) {
		console.log('onComplete');
		this.trigger('ReplicationComplete',{"info":info});
	},

	startListenChanges: function (include_docs = false) {
		var that = this;
		this.changes = this.get('remote').changes({
			since: 'now',
			live: true,
			include_docs: include_docs
		}).on('change', function (change) {
			console.log('onChangesChange');
			that.trigger('ChangesChange',{"change":change});
		}).on('complete', function (info) {
			// changes() was canceled
			console.log('onChangesComplete');
			that.trigger('ChangesComplete',{"info":info});
		}).on('error', function (err) {
			console.log('onChangesError');
			that.trigger('ChangesError',{"err":err});
		});
	},
	stopListenChanges: function () {
		this.changes.cancel();
	},

  willDestroy: function() {
	  this.replicateTo.cancel();
	  this.replicateFrom.cancel();
	  this.changes.cancel();
  },

  _init: function (store, type) {
    var self = this,
        recordTypeName = this.getRecordTypeName(type);
    if (!this.get('db') || typeof this.get('db') !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    if (!Ember.get(type, 'attributes').has('rev')) {
      var modelName = classify(recordTypeName);
      throw new Error('Please add a `rev` attribute of type `string`' +
        ' on the ' + modelName + ' model.');
    }

    this._schema = this._schema || [];

    var singular = recordTypeName;
    var plural = pluralize(recordTypeName);

    // check that we haven't already registered this model
    for (var i = 0, len = this._schema.length; i < len; i++) {
      var currentSchemaDef = this._schema[i];
      if (currentSchemaDef.singular === singular) {
        return;
      }
    }

    var schemaDef = {
      singular: singular,
      plural: plural
    };

    if (type.documentType) {
      schemaDef['documentType'] = type.documentType;
    }

    // else it's new, so update
    this._schema.push(schemaDef);

    // check all the subtypes
    // We check the type of `rel.type`because with ember-data beta 19
    // `rel.type` switched from DS.Model to string
    type.eachRelationship(function (_, rel) {
      if (rel.kind !== 'belongsTo' && rel.kind !== 'hasMany') {
        // TODO: support inverse as well
        return; // skip
      }
      var relDef = {},
          relModel = (typeof rel.type === 'string' ? store.modelFor(rel.type) : rel.type);
      if (relModel) {
        relDef[rel.kind] = {
          type: self.getRecordTypeName(relModel),
          options: rel.options
        };
        if (!schemaDef.relations) {
          schemaDef.relations = {};
        }
        schemaDef.relations[rel.key] = relDef;
        self._init(store, relModel);
      }
    });

    this.get('db').setSchema(this._schema);
  },

  _recordToData: function (store, type, record) {
    var data = {};
    // Though it would work to use the default recordTypeName for modelName &
    // serializerKey here, these uses are conceptually distinct and may vary
    // independently.
    var modelName = type.modelName || type.typeKey;
    var serializerKey = camelize(modelName);
    var serializer = store.serializerFor(modelName);

    var recordToStore = record;
    // In Ember-Data beta.15, we need to take a snapshot. See issue #45.
    if (
      typeof record.record === 'undefined' &&
      typeof record._createSnapshot === 'function'
    ) {
      recordToStore = record._createSnapshot();
    }

    serializer.serializeIntoHash(
      data,
      type,
      recordToStore,
      {includeId: true}
    );

    data = data[serializerKey];

    // ember sets it to null automatically. don't need it.
    if (data.rev === null) {
      delete data.rev;
    }

    return data;
  },

  /**
   * Returns the string to use for the model name part of the PouchDB document
   * ID for records of the given ember-data type.
   *
   * This method uses the camelized version of the model name in order to
   * preserve data compatibility with older versions of ember-pouch. See
   * nolanlawson/ember-pouch#63 for a discussion.
   *
   * You can override this to change the behavior. If you do, be aware that you
   * need to execute a data migration to ensure that any existing records are
   * moved to the new IDs.
   */
  getRecordTypeName(type) {
    if (type.modelName) {
      return camelize(type.modelName);
    } else {
      // This branch can be removed when the library drops support for
      // ember-data 1.0-beta17 and earlier.
      return type.typeKey;
    }
  },

  findAll: function(store, type /*, sinceToken */) {
    // TODO: use sinceToken
    this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type));
  },

  findMany: function(store, type, ids) {
    this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type), ids);
  },

  findQuery: function(/* store, type, query */) {
    throw new Error(
      "findQuery not yet supported by ember-pouch. " +
      "See https://github.com/nolanlawson/ember-pouch/issues/7.");
  },

  /**
   * `find` has been deprecated in ED 1.13 and is replaced by 'new store
   * methods', see: https://github.com/emberjs/data/pull/3306
   * We keep the method for backward compatibility and forward calls to
   * `findRecord`. This can be removed when the library drops support
   * for deprecated methods.
  */
  find: function (store, type, id) {
    return this.findRecord(store, type, id);
  },

  findRecord: function (store, type, id) {
    this._init(store, type);
    var recordTypeName = this.getRecordTypeName(type);
    return this.get('db').rel.find(recordTypeName, id).then(function (payload) {
      // Ember Data chokes on empty payload, this function throws
      // an error when the requested data is not found
      if (typeof payload === 'object' && payload !== null) {
        var singular = recordTypeName;
        var plural = pluralize(recordTypeName);

        var results = payload[singular] || payload[plural];
        if (results && results.length > 0) {
          return payload;
        }
      }
      throw new Error('Not found: type "' + recordTypeName +
        '" with id "' + id + '"');
    });
  },

  createRecord: function(store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.save(this.getRecordTypeName(type), data);
  },

  updateRecord: function (store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.save(this.getRecordTypeName(type), data);
  },

  deleteRecord: function (store, type, record) {
    this._init(store, type);
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.del(this.getRecordTypeName(type), data)
      .then(extractDeleteRecord);
  },
	destroyLocalDb: function () {
		this._schema = [];
		return this.get('db').destroy();
	}
});

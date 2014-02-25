(function() {
/*global Ember*/
/*global DS*/
/*global socket*/
'use strict';

var RSVP = Ember.RSVP;
var get = Ember.get;

DS.SailsAdapter = DS.Adapter.extend({
  defaultSerializer: '_default',
  prefix: '',
  camelize: true,
  log: false,
  init: function () {
    this._listenToSocket();
    this._super();
  },

  // TODO find a better way to handle this

  // Reason: In a Sails Model updated, created, or destoryed message
  // the model name is always lowercase. This makes it difficult to
  // lookup models with multipart names on the ember container.

  // One solution could be to implement a custom resolveModel method
  // on the resolver to work with lowercase names. But in some cases
  // we don't want to impose a custom resolver requirement on users of
  // the sails_adapter.

  // This modelName hash is an ugly escape has that allows a user to
  // define a mapping between the sails lowercase model name and a
  // string that ember can use to recognize a model with multiple
  // parts.

  // For Example A `User` model would not need to be registered with
  // this map because ember can use the string 'user' to look up the
  // model just fine. However a `ContentType` model will need to be
  // registered with this map because attempting to lookup a model
  // named 'contenttype' will not return the `ContentType` model.

  // modelNameMap: {'contenttype': 'ContentType'}
  modelNameMap: {},

  find: function(store, type, id) {
    return this.socket(this.buildURL(type.typeKey, id), 'get');
  },

  createRecord: function(store, type, record) {
    var serializer = store.serializerFor(type.typeKey);
    var data = serializer.serialize(record, { includeId: true });

    return this.socket(this.buildURL(type.typeKey), 'post', data);
  },

  updateRecord: function(store, type, record) {
    var serializer = store.serializerFor(type.typeKey);
    var data = serializer.serialize(record);

    var id = get(record, 'id');

    return this.socket(this.buildURL(type.typeKey, id), 'put', data);
  },

  deleteRecord: function(store, type, record) {
    var serializer = store.serializerFor(type.typeKey);
    var id = get(record, 'id');

    var data = serializer.serialize(record);

    return this.socket(this.buildURL(type.typeKey, id), 'delete', data);
  },

  findAll: function(store, type, sinceToken) {
    return this.socket(this.buildURL(type.typeKey), 'get');
  },

  findQuery: function(store, type, query) {
    return this.socket(this.buildURL(type.typeKey), 'get', query);
  },

  isErrorObject: function(data) {
    return !!data.status;
  },

  socket: function(url, method, data ) {
    var isErrorObject = this.isErrorObject.bind(this);
    method = method.toLowerCase();
    var adapter = this;
    adapter._log(method, url, data);
    return new RSVP.Promise(function(resolve, reject) {
      socket[method](url, data, function (data) {
        if (isErrorObject(data)) {
          adapter._log('error:', data);
          if (data.errors) {
            reject(new DS.InvalidError(adapter.formatError(data)));
          } else {
            reject(data);
          }
        } else {
          resolve(data);
        }
      });
    });
  },

  ajax: function(url, type, hash) {
    var adapter = this;

    return new Ember.RSVP.Promise(function(resolve, reject) {
      hash = adapter.ajaxOptions(url, type, hash);

      hash.success = function(json) {
        Ember.run(null, resolve, json);
      };

      hash.error = function(jqXHR, textStatus, errorThrown) {
        Ember.run(null, reject, adapter.ajaxError(jqXHR));
      };

      Ember.$.ajax(hash);
    }, "DS: RestAdapter#ajax " + type + " to " + url);
  },

  ajaxOptions: function(url, type, hash) {
    hash = hash || {};
    hash.url = url;
    hash.type = type;
    hash.dataType = 'json';
    hash.context = this;

    if (hash.data && type !== 'GET') {
      hash.contentType = 'application/json; charset=utf-8';
      hash.data = JSON.stringify(hash.data);
    }

    var headers = get(this, 'headers');
    if (headers !== undefined) {
      hash.beforeSend = function (xhr) {
        [].forEach.call(Ember.keys(headers), function(key) {
          xhr.setRequestHeader(key, headers[key]);
        });
      };
    }


    return hash;
  },

  ajaxError: function(jqXHR) {
    if (jqXHR) {
      jqXHR.then = null;
    }

    return jqXHR;
  },

  buildURL: function(type, id) {
    var url = [];

    type = type || '';
    if (this.camelize) {
      type = Ember.String.camelize(type);
    }

    if (type) {
      url.push(type);
    }
    if (id) { url.push(id); }

    url = url.join('/');
    url = this.prefix + '/' + url;

    return url;
  },

  _listenToSocket: function() {
    var self = this;
    var store = this.container.lookup('store:main');
    var App = this.container.lookup('application:main');

    function findModelName(model) {
      var mappedName = self.modelNameMap[model];
      return mappedName || model;
    }

    function pushMessage(message) {
      var modelName = findModelName(message.model);
      var type = store.modelFor(modelName);
      var serializer = store.serializerFor(type.typeKey);
      var record = serializer.extractSingle(store, type, message.data);
      store.push(modelName, record);
    }

    socket.on('message', function (message) {
      if (message.verb === 'create') {
        pushMessage(message);
      }
      if (message.verb === 'update') {
        pushMessage(message);
      }
      // TODO delete
    });
  },

  _log: function() {
    if (this.log) {
      console.log.apply(console, arguments);
    }
  },

  /*
   Sails error objects look something like this:

   {"status":500,
    "errors":[{"ValidationError":{"endDate":[{"data":"Mon, 02 Jan 2012 02:00:00 GMT",
                                           "message":"Validation error: \"Mon, 02 Jan 2012 02:00:00 GMT\" Rule \"after(Wed, 01 Jan 2014 01:00:00 GMT)\" failed.",
                                           "rule":"after",
                                           "args":["Wed, 01 Jan 2014 01:00:00 GMT"]}]}}]}

   Ember wants the error object to look like this:

   {endDate: "Validation error: ..."}
   */
  formatError: function(error) {
    var memo = {};
    error.errors.forEach(function(errorGroup) {
      Object.keys(errorGroup).forEach(function(errorName) {
        // {'ValidationError': {}}
        var errorType = errorGroup[errorName];
        Object.keys(errorType).forEach(function(propName) {
          var newMessages = errorType[propName].map(function(error) {
            return error.message;
          });
          var messages = memo[propName] || [];
          memo[propName] = [].concat(messages, newMessages);
        });
      });
    });
    return Ember.Object.create(memo);
  }
});

})();

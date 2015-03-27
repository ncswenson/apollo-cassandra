var cql = require("cassandra-driver"),
    types = cql.types,
    SingleNodePolicy = require( __dirname + '/./single_node_policy'),
    async = require('async'),
    util = require("util"),
    BaseModel = require('./base_model'),
    schemer = require('./apollo_schemer'),
    lodash = require("lodash");

var DEFAULT_REPLICATION_FACTOR = 1;

var noop = function(){};

function _classComparator (classOne, classTwo) {
    if (classOne !== classTwo) {
        var _refs = [];
        var isDone = false;
        var prototype = classOne;
        while (!isDone) {
            if (!prototype) {
                throw('Model must be sub class of the apollo provided base model');
            }
            if (prototype instanceof classTwo) {
                isDone = true;
            } else {
                var alreadyFound = false;
                _refs.forEach(function (r) {
                    if (r === prototype) {
                        alreadyFound = true;
                    }
                });
                if (alreadyFound) prototype = null;
                else {
                    _refs.push(prototype);
                    prototype = classOne.prototype;
                }
            }
        }
    }
}


/**
 * Utilità per cassandra
 * @param {Apollo~Connection} connection configurazione di Apollo
 * @param {Apollo~CassandraOptions} options - Cassandra options
 * @class
 */
var Apollo = function(connection, options){
    if(!connection) throw "Data connection configuration undefined";
    options = options || {};
    this._options = lodash.defaults(options, {
        replication_strategy : {'class' : 'SimpleStrategy', 'replication_factor' : DEFAULT_REPLICATION_FACTOR }
    });
    this._models = {};
    this._keyspace = connection.keyspace;
    this._connection = connection;
    //Compatibility with old parameters name
    if(this._connection.hosts && !this._connection.contactPoints)
        this._connection.contactPoints = this._connection.hosts;
    this._client = null;
};


Apollo.prototype = {

    /**
     * Generate a Model
     * @param  {object} properties Properties for the model
     * @return {Model}            Construcotr for the model
     * @private
     */
    _generate_model : function(properties){
        this._generate_model_from_model(properties, BaseModel);
    },

    /**
     * Generate model from a model
     * @param properties
     * @private
     */
    _generate_model_from_model : function(properties, model){
        /**
         * Create a new instance for the model
         * @class Model
         * @augments BaseModel
         * @param {object} instance_values Key/value object containing values of the row  *
         * @classdesc Generic model. Use it statically to find documents on Cassandra. Any instance represent a row retrieved or which can be saved on DB
         */
        var Model = function(instance_values){
            model.apply(this,Array.prototype.slice.call(arguments));
        };

        util.inherits(Model,model);

        for(var i in model){
            if(model.hasOwnProperty(i)){
                Model[i] = model[i];
            }
        }

        // Extend BaseModel static properties if needed
        for(var j in BaseModel){
            if(!Model.hasOwnProperty(j)) {
                Model[j] = BaseModel[j];
            }
        }

        Model._set_properties(properties);

        return Model;
    },

    /**
     * Returns a client to be used only for keyspace assertion
     * @return {Client} Node driver client
     * @private
     */
    _get_system_client : function(){
        var copy_fields = ['contactPoints'],
            temp_connection = {},
            connection = this._connection;

        for(var fk in copy_fields){
            temp_connection[copy_fields[fk]] = connection[copy_fields[fk]];
        }
        return new cql.Client(temp_connection);
    },

    /**
     * Generate replication strategy text for keyspace creation query
     * @param  {object|string} replication_option An object or a string representing replication strategy
     * @return {string}                    Replication strategy text
     * @private
     */
    _generate_replication_text : function(replication_option){
        if( typeof replication_option == 'string'){
            return replication_option;
        }else{
            var properties = [];
            for(var k in replication_option){
                properties.push(util.format("'%s': '%s'", k, replication_option[k] ));
            }
            return util.format('{%s}', properties.join(','));
        }
    },

    /**
      * Ensure specified keyspace exists, try to create it otherwise
      * @param  {Apollo~GenericCallback} callback Called on keyspace assertion
      * @private
      */
    _assert_keyspace : function(callback){

        var client = this._get_system_client();
        var keyspace_name = this._connection.keyspace,
            replication_text = '',
            options = this._options;

        replication_text = this._generate_replication_text(options.replication_strategy);

        var query = util.format(
            "CREATE KEYSPACE IF NOT EXISTS %s WITH REPLICATION = %s;",
            keyspace_name,
            replication_text
        );
        client.execute(query, function(err,result){
            client.shutdown(function(){
                callback(err,result);
            });
        });
    },

    /**
     * Set internal clients
     * @param {object} client Node driver client
     * @private
     */
    _set_client : function(client){
        var define_connection_options = lodash.clone(this._connection);

        define_connection_options.policies = {
            loadBalancing: new SingleNodePolicy()
        };

        //define_connection_options.hosts = define_connection_options.contactPoints;

        this._client = client;
        this._define_connection = new cql.Client(define_connection_options);

        /*this._client.on('log',function(level, message){
            console.log(message);
        });*/
        //Reset connections on all models
        for(var i in this._models){
            this._models[i]._properties.cql = this._client;
            this._models[i]._properties.define_connection = this._define_connection;
        }
    },

    /**
     * Generate a uuid
     * @method
     * @returns {string} A uuid to be used in queries
     */
    uuid: function(){
        var uuid = types.Uuid.random();
        return uuid.toString();
    },

    /**
     * Generate a timeuuid
     * @method
     * @returns {string} A timeuuid to be used in queries
     */
    timeuuid: function(){
        var timeuuid = types.TimeUuid.now();
        return timeuuid.toString();
    },

    /**
     * Connect your instance of Apollo to Cassandra
     * @param  {Apollo~onConnect} callback Callback on connection result
     */
    connect : function(callback){
        var on_keyspace = function(err){
            if(err){ return callback(err);}
            this._set_client(new cql.Client(this._connection));
            callback(err, this);
        };

        if(this._keyspace){
            this._assert_keyspace( on_keyspace.bind(this) );
        }else{
            on_keyspace.call(this);
        }
    },

    /**
     * Register model
     *
     * Adds model based on the schema and model provided
     */
    add_model_with_model : function(model_name, model_schema, model, options) {
        if(!model_name || typeof(model_name) != "string")
            throw("Si deve specificare un nome per il modello");

        // Check that constructor is sub class of BaseModel
        _classComparator(model, BaseModel);

        options = options || {};
        options.mismatch_behaviour = options.mismatch_behaviour || 'fail';
        if(options.mismatch_behaviour !== 'fail' && options.mismatch_behaviour !== 'drop')
            throw 'Valid option values for "mismatch_behaviour": "fail" , "drop". Got: "'+options.mismatch_behaviour+'"';

        //model_schema = schemer.normalize_model_schema(model_schema);
        schemer.validate_model_schema(model_schema);

        var base_properties = {
            name : model_name,
            schema : model_schema,
            keyspace : this._keyspace,
            mismatch_behaviour : options.mismatch_behaviour,
            define_connection : this._define_connection,
            cql : this._client,
            get_constructor : this.get_model.bind(this,model_name),
            connect: this.connect.bind(this)
        };

        return (this._models[model_name] = this._generate_model_from_model(base_properties, model));
    },

    /**
     * Create a model based on proposed schema
     * @param {string}  model_name - Name for the model
     * @param {object}  model_schema - Schema for the model
     * @param {Apollo~ModelCreationOptions} options - Options for the creation
     * @return {Model} Model constructor
     */
    add_model : function(model_name, model_schema, options) {
        return this.add_model_with_model(model_name, model_schema, BaseModel, options);
    },

    /**
     * Get a previous registered model
     * @param  {string} model_name - Name used during [add_model]{@link Apollo#add_model}
     * @return {Model} The required model
     */
    get_model : function(model_name){
        return this._models[model_name] || null;
    },

    /**
     * Get base model
     */
    get_base_model : function(){
        return BaseModel;
    },

    /**
     * Chiusura della connessione
     * @param  {Function} callback callback
     */
    close : function(callback){
        callback = callback || noop;

        if(!this._client){
            return callback();
        }
        this._client.shutdown(function(err){
            if(!this._define_connection){
                return callback(err);
            }
            this._define_connection.shutdown(function(derr){
                callback(err || derr);
            });
        }.bind(this));
    }
};

module.exports = Apollo;

/**
 * Generic callback with just error parameter.
 * @callback Apollo~GenericCallback
 * @param {object} err
 */

/**
 * This callback is displayed as part of the Apollo class.
 * @callback Apollo~onConnect
 * @param {object} err
 */

/**
 * Options for cassandra client
 * @typedef {Object} Apollo~CassandraOptions
 * @property {(object|string)} [replication_strategy={ 'class': 'SimpleStrategy', 'replication': 1 }] - replication strategy configuration object or string
 */

/**
 * Options for the model creation method
 * @typedef {Object} Apollo~ModelCreationOptions
 * @property {string} [mismatch_beahaviour='fail'] - Which behaviour should have creation whne a table already exists on Cassandra with the same name of your model and schema differ from proposed one.<br />
 * Valid options are `fail`, `drop`.<br />
 * On fail, creation will fail and an error will be raised: this is the default. On drop, existing table will be dropped (use carefully)
 */

 /**
  * Options for connection of Cassandra client
  * @typedef {Object}  Apollo~Connection
  * @property {array}  contactPoints - Array of string in host:port format. Port is optional (default 9042).
  * @property {string} keyspace - Name of keyspace to use.
  * @property {string} [username=null] - User for authentication.
  * @property {string} [password=null] - Password for authentication.
  * @property {int}    [staleTime=1000] - Time in milliseconds before trying to reconnect to a node.
  * @property {int}    [maxExecuteRetries=3] - Maximum amount of times an execute can be retried using another connection, in case the server is unhealthy.
  * @property {int}    [getAConnectionTimeout=3500] - Maximum time in milliseconds to wait for a connection from the pool.
  * @property {int}    [poolSize=1] - Number of connections to open for each host
  */

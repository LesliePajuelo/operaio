var _ = require('lodash');
var async = require('async');
var backoff = require('backoff');
var Dockerode = require('dockerode');
var fs = require('fs');
var LineWrapper = require('stream-line-wrapper');
var path = require('path');
var request = require('request');
var stream = require('stream');
var url = require('url');
var util = require('util');
var winston = require('winston');
var yaml = require('js-yaml');
var yargs = require('yargs');

var internals = {};

internals.logger = new winston.Logger({
    transports: [
        new winston.transports.Console()
    ]
});

exports.sendToKairos = function (payload) {

    internals.logger.info('Received request to send to kairos');
    
    var options = {
        method: 'POST',
        url: 'http://kairos.stg.rapido.globalproducts.qa.walmart.com/api/v1/datapoints',
        json: true,
        body: payload
    };

    request.post(options, function (err, res, body) {
        internals.logger.info('REQUEST RESULTS:', err, body);
    });
};


exports.yamlValidation = function (yamlObject, state, tenant) {
    var timestamp = Date.now();
    var timings = {};

    if (_.isObject(yamlObject)) {
        internals.logger.info('yamlObject has been created');
    }

    if (yamlObject.budget) {

        if (yamlObject.budget.actions) {
            actions = yamlObject.budget.actions;
        }

        if (yamlObject.budget.metrics && yamlObject.budget.metrics.timings) {
            internals.logger.info('metrics timings exist');
            timings = yamlObject.budget.metrics.timings;

            _.mapKeys(timings, function (value, key) {
                // paylodObject declared here to prevent accumulation
                var payload = [{
                    "name": "rapido." + tenant + ".budget." + key,
                    "datapoints": [[timestamp,  value]],
                    "tags": {
                        "profile": "default"
                    }
                }];
                exports.sendToKairos(payload);

            });

            if (yamlObject.budget.actions) {
                if (_.indexOf(actions, 'break-build') !== -1) {
                    internals.logger.info('breakbuild', state.budget);
                    fs.writeFile(state.budget, JSON.stringify(yamlObject.budget.metrics), 'utf8', function (err) {
                        if (err) throw err;
                    });
                }

                if (_.indexOf(actions, 'alert') !== -1) {
                    fs.writeFile(state.budgetAlert, JSON.stringify(yamlObject.budget.metrics), 'utf8', function (err) {
                        if (err) {
                            throw err;
                        }
                    });
                }
            }
        }
    } else {
        fs.writeFileSync(state.budget, "{'timings': {'headerTime': 500}", 'utf8');
        internals.logger.info('Empty budget file has been created for sitespeed');
    }
};
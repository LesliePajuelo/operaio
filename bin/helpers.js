var _ = require('lodash');
var async = require('async');
var backoff = require('backoff');
var Dockerode = require('dockerode');
var fs = require('fs');
var yaml = require('js-yaml');
var LineWrapper = require('stream-line-wrapper');
var path = require('path');
var request = require('request');
var stream = require('stream');
var url = require('url');
var util = require('util');
var winston = require('winston');
var yargs = require('yargs');

var internals = {};

internals.logger = new winston.Logger({
    transports: [
        new winston.transports.Console()
    ]
});

exports.sendToKairos = function (metricname, timestamp, payload) {
    internals.logger.info('Received request to send to kairos')
    var options = {method: 'POST',
        url: 'kairos.stg.rapido.globalproducts.qa.walmart.com/api/v1/datapoints',
        headers:
        {'postman-token': 'a82f3434-d82c-eb5d-3fff-e48cd1255b97',
            'cache-control': 'no-cache',
            'authorization': 'Basic YWRtaW46YWRtaW4=',
            'content-type': 'application/json'},
        body:
            [{name: metricname,
                datapoints:
                    [[timestamp,
                        payload
                    ]],
                tags: {profile: 'default'}}],
        json: true};

    request(options, function (error, response, body) {
        if (error) {
            internals.logger.info('Oh noes! there was an error sending to kairos: ', error, response, body);
            throw new Error(error);
        }
    });
};

exports.yamlValidation = function (yamlObject, state, tenant) {
    var metricname = '';
    var payload = '';
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
                //paylodObject defined here to prevent accumulation of metricname.
                var payloadObject = {};
                metricname = util.format('rapido.test.%s_budget_%s', tenant, key);
                payloadObject[metricname] = value;
                payload = JSON.stringify(payloadObject);

                internals.logger.info('Sending to Kairos ', payload);
                sendToKairos(metricname, timestamp, payload);
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
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

exports.alertSpotlight = function () {

};

exports.sendToKairos = function (payload, state) {
    var options = {
        method: 'POST',
        url: 'http://kairos.stg.rapido.globalproducts.qa.walmart.com/api/v1/datapoints',
        json: true,
        body: payload
    };

    request.post(options);
};

exports.yamlValidation = function (performanceBudget, state, tenant) {
    var timestamp = Date.now();
    var timings = {};

    if (!_.isObject(performanceBudget)) {
        internals.logger.info('performanceBudget has not been created');
    }

    if (performanceBudget.budget) {

        if (performanceBudget.budget.actions) {
            actions = performanceBudget.budget.actions;
        }

        if (performanceBudget.budget.metrics && performanceBudget.budget.metrics.timings) {
            timings = performanceBudget.budget.metrics.timings;

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

            if (performanceBudget.budget.actions) {
                if (_.indexOf(actions, 'break-build') !== -1) {
                    fs.writeFile(state.budget, JSON.stringify(performanceBudget.budget.metrics), 'utf8', function (err) {
                        if (err) throw err;
                    });
                }

                if (_.indexOf(actions, 'alert') !== -1) {
                    fs.writeFile(state.budgetAlert, JSON.stringify(performanceBudget.budget.metrics), 'utf8', function (error) {
                        if (error) {
                            throw error;
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

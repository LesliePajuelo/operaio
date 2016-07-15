var _ = require('lodash');
var async = require('async');
var backoff = require('backoff');
var budgetAlert = require('/tmp/budgetAlert.json');
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

internals.initializeSpotlight = function () {
  internals.logger.info('SPOTLIGHT INITIALIZED')
  //Value given by Spotlight team
  var rapidoId = '5a9c32cc-85b9-4a46-b6e8-113cfb0a1ee5';
  var spotlightUrl = 'https://services.spotlight.stg.walmart.com/api/v1';
  //Define event type. Needs to run once, could be through postman

  var eventType = {
    "name": "CE_Rapido_Exceed_Budget",
    "description": "Denotes that a metric failed its performance budget",
    "properties": [
      {
        "name": "MetricName",
        "type": "STRING"
      },
      {
        "name": "OverBudgetBy_ms",
        "type": "NUMBER"
      },
      {
        "name": "GitSha",
        "type": "STRING"
      }
    ]
  };

  var postOptions = {
    body: eventType,
    json: true,
    url: 'https://services.spotlight.stg.walmart.com/api/v1/5a9c32cc-85b9-4a46-b6e8-113cfb0a1ee5/eventTypes'
  };

  request.post(postOptions, function (error, response) {
  if (error) {
    internals.logger.info(error);
  }
});
};

internals.compareBudget = function (state) {
  var measuredValue = 0;
  var tenant = _.snakeCase(path.join(state.options.githubOrg, state.options.githubRepo));

  _.forEach(budgetAlert, function(timings) {
    _.forEach(timings, function(budgetValue, key){

      var payload = {
        "start_relative": {
          "value": "1",
          "unit": "days"
        },
        "end_relative": {
          "value": "1",
          "unit": "seconds"
        },
        "metrics":[{
          "name": "rapido." + tenant + ".http_dev_walmart_com_3000." + key,
          "tags": {
              "profile": "default"
          },
          "order": "desc",
          "limit": 1
        }
      ]
      }

      helpers.kairosQuery(payload, state, function(res, body){
        // internals.logger.info('KairosQuery Success', res.statusCode, body)
        measuredValue = body.queries[0].results[0].values[0][1];
        if (measuredValue > budgetValue) {
          internals.logger.info(key, ' is over budget by ', measuredValue - budgetValue, 'milliseconds')
        } else {
          internals.logger.info(key, ' is at or under budget by ', budgetValue - measuredValue, 'milliseconds' )
        }
      });
    });
  });
};

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
                        } else {
                          internals.compareBudget(state);
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

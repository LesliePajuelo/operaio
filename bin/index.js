#!/usr/bin/env node

'use strict';

// Dependencies

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
var yargs = require('yargs');
var _ = require('lodash');

// Internal members

var internals = {};

// Constants

internals.SITESPEED_CPU_SHARES = 2 * 1024;

internals.SITESPEED_RETRY_INTERVAL = 30 * 1000;

internals.SPEED_QUOTES = [
  '"Every car has a lot of speed in it. The trick is getting the speed out of it." AJ Foyt',
  '"I am not a speed reader. I am a speed understander." Isaac Asimov',
  '"If everything seems under control, you\'re not going fast enough." Mario Andretti',
  '"It is not always possible to be the best, but it is always possible to improve your own performance." Jackie Stewart',
  '"Racing is life. Anything before or after is just waiting." Steven McQueen',
  '"Speed provides the one genuinely modern pleasure." Aldous Huxley'
];

// Variables

internals.logger = new winston.Logger({
  transports: [
    new winston.transports.Console()
  ]
});

// Methods

internals.build = function (state, next) {
  var containerId = process.env.ELECTRODE_APP_BUILDER;

  var options = {
    AttachStderr: true,
    AttachStdin: true,
    AttachStdout: true,
    Cmd: null,
    Env: [
      util.format('APP_BUILD_CMD=%s', state.options.appBuildCmd),
      util.format('GITHUB_BRANCH_OR_SHA=%s', state.options.gitSha),
      util.format('GITHUB_KEY=%s', state.options.githubToken),
      util.format('GITHUB_ORG=%s', state.options.githubOrg),
      util.format('GITHUB_REPO=%s', state.options.githubRepo)
    ],
    Image: 'electrode-app-builder',
    OpenStdin: true,
    StdinOnce: false,
    Tty: true
  };

  if (containerId) {
    state.containers.electrodeAppBuilder = {
      instance: {
        id: containerId
      }
    };

    internals.logger.info('Reusing container with previously built application...', containerId);

    return next(null, state);
  }

  internals.logger.info('Starting container to build application...', options);

  return internals.dockerRunAttached(state.docker, options, function (error, container) {
    if (error) {
      internals.logger.error('Error while building application!', error, container);
    } else {
      internals.logger.info('Application successfully built.', container);
    }

    state.containers.electrodeAppBuilder = container;

    next(error, state);
  });
};

internals.createDockerClient = function () {
  var isRemote = process.env.DOCKER_HOST && process.env.DOCKER_CERT_PATH;
  return isRemote ? internals.createRemoteDockerClient() : internals.createLocalDockerClient();
};

internals.createLocalDockerClient = function () {
  var socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

  var options = {
    socketPath: socketPath
  };

  internals.logger.info('Creating local docker client...', options);

  return new Dockerode(options);
};

internals.createLogStream = function (prefix) {
  var logStream = new stream.PassThrough();
  var options = {
    prefix: prefix
  };
  var lineWrapper = new LineWrapper(options);
  logStream.pipe(lineWrapper).pipe(process.stdout);
  return logStream;
};

internals.createRemoteDockerClient = function () {
  var dockerHost = process.env.DOCKER_HOST;
  var parsedDockerHost = url.parse(dockerHost);
  var dockerCertPath = process.env.DOCKER_CERT_PATH;

  var ca = fs.readFileSync(path.join(dockerCertPath, 'ca.pem'));
  var cert = fs.readFileSync(path.join(dockerCertPath, 'cert.pem'));
  var key = fs.readFileSync(path.join(dockerCertPath, 'key.pem'));

  var options = {
    protocol: 'https',
    host: parsedDockerHost.hostname,
    port: parsedDockerHost.port,
    checkServerIdentity: false,
    ca: ca,
    cert: cert,
    key: key
  };

  internals.logger.info('Creating remote docker client...', options);

  return new Dockerode(options);
};

internals.dockerRunAttached = function (docker, options, callback) {
  var stream = internals.createLogStream(util.format('[%s] ', options.Image));

  docker.run(options.Image, options.Cmd, stream, options, function (error, data, container) {
    var statusCode = data && data.StatusCode;

    if (error) {
      return callback(error, {
        instance: container
      });
    }

    if (statusCode !== 0) {
      return callback(new Error(util.format('Container from "%s" image returned status code %d.', options.Image, statusCode)), {
        instance: container
      });
    }

    return container.inspect(function (error, data) {
      callback(error, {
        instance: container,
        data: data
      });
    });
  });
};

internals.dockerRunDetached = function (docker, options, callback) {
  var onCreate = function (error, container) {
    var onInspect = function (error, data) {
      callback(error, {
        instance: container,
        data: data
      });
    };

    var onStart = function (error) {
      if (error) {
        return callback(error);
      }

      return container.inspect(onInspect);
    };

    if (error) {
      return callback(error);
    }

    return container.start(onStart);
  };

  docker.createContainer(options, onCreate);
};

internals.getOptions = function () {
  return yargs.usage('Usage: operaio [options]')
    .demand('app-build-cmd')
    .string('app-build-cmd')
    .demand('app-server-cmd')
    .string('app-server-cmd')
    .default('app-server-hostname', 'dev.walmart.com')
    .string('app-server-hostname')
    .demand('git-sha')
    .string('git-sha')
    .demand('github-org')
    .string('github-org')
    .demand('github-repo')
    .string('github-repo')
    .demand('github-token')
    .string('github-token')
    .default('kairos-host', 'kairos.stg.rapido.globalproducts.qa.walmart.com')
    .string('kairos-host')
    .string('mock-server-cmd')
    .default('mock-server-hostname', 'dev.walmart.com')
    .string('mock-server-hostname')
    .default('prefix', 'rapido')
    .string('prefix')
    .default('profile', 'default')
    .string('profile')
    .boolean('resource-timing')
    .default('resource-timing', false)
    .string('sitespeed-output-dir')
    .number('sitespeed-retries')
    .default('sitespeed-retries', 3)
    .default('sitespeed-sample-size', 10)
    .number('sitespeed-sample-size')
    .boolean('sitespeed-screenshot')
    .number('timestamp')
    .default('timestamp', Date.now())
    .demand('url')
    .array('url')
    .epilog(internals.getRandomQuote())
    .argv;
};

internals.getRandomQuote = function () {
  var random = _.random(0, internals.SPEED_QUOTES.length - 1);
  return internals.SPEED_QUOTES[random];
};

internals.gitToKairos = function (state, next){
  internals.logger.info("gitsha", state.options.gitSha);

  var metric = state.options.gitSha;
  var snake_Org = _.snakeCase(state.options.githubOrg);
  var snakeRepo = _.snakeCase(state.options.githubRepo);
  var metricname = "rapido." + snake_Org + "_" + snakeRepo + ".gitcommit";

  internals.logger.info("metric: ", metricname);
  var timestamp = Date.now();
  var url = "https://gecgithub01.walmart.com" + "/"+ state.options.githubOrg + "/" + state.options.githubRepo + "/" +
      "commit/" + state.options.gitSha;

  var payloadObject = {'gitcommit': metric,'giturl': url};
  var payload = JSON.stringify(payloadObject);
  
  internals.logger.info("payload ", payload);

  var options = { method: 'POST',
    url: 'kairos.stg.rapido.globalproducts.qa.walmart.com/api/v1/datapoints',
    headers:
    { 'postman-token': 'a82f3434-d82c-eb5d-3fff-e48cd1255b97',
      'cache-control': 'no-cache',
      'authorization': 'Basic YWRtaW46YWRtaW4=',
      'content-type': 'application/json' },
    body:
        [ { name: metricname,
          datapoints:
              [ [ timestamp,
                payload
              ] ],
          tags: { profile: 'default' } } ],
    json: true };

  request(options, function (error, response, body) {
    if (error) throw new Error(error);
  });

  next(null, state);

};


internals.initialize = function (next) {
  var state = {
    containers: {}
  };

  state.options = internals.getOptions();

  internals.logger.info('Initializing...');

  state.docker = internals.createDockerClient();

  internals.logger.info('Initialization complete.');

  next(null, state);
};

internals.onDone = function (error, state) {
  if (error) {
    internals.logger.error('Something went wrong! (╯°□°）╯︵ ┻━┻ ', error);
  }

  internals.tearDown(state.containers, function (ignore, errors) {
    var errorsCount = _.chain(errors)
      .compact()
      .size()
      .value();

    var exitCode = error || errorsCount ? -1 : 0;

    internals.logger.info('All done!');

    process.exit(exitCode);
  });
};

internals.run = function () {
  async.waterfall([
    internals.initialize,
    internals.build,
    internals.testMockServer,
    internals.startAppServer,
    internals.waitForAppServer,
    internals.runSiteSpeed,
    internals.gitToKairos
  ], internals.onDone);
};

internals.runSiteSpeed = function (state, next) {
  var chromeJsonPath = path.resolve(__dirname, '../volumes/sitespeed/chrome.json');
  var mobProxyPatchPath = path.resolve(__dirname, '../patches/mobproxy.js');
  var nodeModulesPath = path.resolve(__dirname, '../node_modules');
  var tenant = _.snakeCase(path.join(state.options.githubOrg, state.options.githubRepo));

  var binds = [
    util.format('%s:/tmp/chrome.json', chromeJsonPath),
    util.format('%s:/usr/lib/node_modules/sitespeed.io/node_modules/browsertime/lib/proxy/mobproxy.js', mobProxyPatchPath),
    util.format('%s:/tmp/node_modules', nodeModulesPath)
  ];

  var extraHosts = [
    util.format('dev.walmart.com:%s', state.containers.electrodeApp.data.NetworkSettings.IPAddress)
  ];
  
  internals.logger.info("State.options.url ", state.options.url)
  var urls = state.options.url[0].split(" ");
  var tasks = _.map(urls, function (url) {
    return function (callback) {
      var cmd = [
        'sitespeed.io',
        '--annessoKairosHost',
        state.options.kairosHost,
        '--annessoPrefix',
        state.options.prefix,
        '--annessoProfile',
        state.options.profile,
        '--annessoResourceTiming',
        state.options.resourceTiming.toString(),
        '--annessoTenant',
        tenant,
        '--annessoTimestamp',
        state.options.timestamp.toFixed().toString(10),
        '--btConfig',
        '/tmp/chrome.json',
        '--collectors',
        '/tmp/node_modules/@walmart/annesso/lib/collectors',
        '--noYslow',
        'true',
        '--postTasksDir',
        '/tmp/node_modules/@walmart/annesso/lib/postActions',
        '--resultBaseDir',
        '/tmp/sitespeed_result',
        '--seleniumServer',
        'http://0.0.0.0:4444/wd/hub',
        '--verbose',
        '-b',
        'chrome',
        '-d',
        '0',
        '-n',
        state.options.sitespeedSampleSize.toFixed().toString(10),
        '-u',
        url
      ];

      var options = {
        AttachStderr: true,
        AttachStdin: true,
        AttachStdout: true,
        Cmd: cmd,
        HostConfig: {
          Binds: binds,
          CpuShares: internals.SITESPEED_CPU_SHARES,
          ExtraHosts: extraHosts
        },
        Image: 'sitespeedio/sitespeed.io:3.11.5',
        OpenStdin: true,
        StdinOnce: false,
        Tty: true
      };

      if (state.options.sitespeedScreenshot) {
        options.Cmd.push('--screenshot');
      }

      internals.logger.info('Running sitespeed.io for %s...', url, options);

      internals.dockerRunAttached(state.docker, options, function (error, container) {
        var key = util.format('siteSpeed_%s', container.instance.id);

        if (error) {
          internals.logger.error('Error while running sitespeed.io!', error);
        }

        state.containers[key] = container;

        callback(error, state);
      });
    };
  });

  var retryableTasks = _.map(tasks, function (task) {
    var options = {
      interval: internals.SITESPEED_RETRY_INTERVAL,
      times: state.options.sitespeedRetries
    };

    return async.retry(options, task);
  });

  async.series(retryableTasks, function (error, results) {
    next(error, results[0]);
    internals.logger.info("RESULTS[0] ",results[0])
  });
};

internals.startAppServer = function (state, next) {
  var options = {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: null,
    Env: [
      util.format('APP_SERVER_CMD=%s', state.options.appServerCmd)
    ],
    HostConfig: {
      PublishAllPorts: true,
      VolumesFrom: [
        state.containers.electrodeAppBuilder.instance.id
      ]
    },
    Image: 'electrode-app',
    OpenStdin: false,
    StdinOnce: false,
    Tty: false
  };

  if (state.containers.ottoMockServer) {
    options.HostConfig.ExtraHosts = [
      util.format('dev.walmart.com:%s', state.containers.ottoMockServer.data.NetworkSettings.IPAddress)
    ];
    options.HostConfig.Links = [
      util.format('%s:otto-mock-server', state.containers.ottoMockServer.data.Name)
    ];
  } else {
    options.HostConfig.ExtraHosts = [
      'dev.walmart.com:0.0.0.0'
    ];
  }

  internals.logger.info('Starting application server...', options);

  internals.dockerRunDetached(state.docker, options, function (error, container) {
    if (error) {
      internals.logger.error('Error while starting application server!', error);
    }

    state.containers.electrodeApp = container;

    next(error, state);
  });
};

internals.startMockServer = function (state, next) {
  var options = {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: null,
    Env: [
      util.format('MOCK_SERVER_CMD=%s', state.options.mockServerCmd)
    ],
    HostConfig: {
      PublishAllPorts: true,
      VolumesFrom: [
        state.containers.electrodeAppBuilder.instance.id
      ]
    },
    Hostname: state.options.mockServerHostname,
    Image: 'otto-mock-server',
    OpenStdin: false,
    StdinOnce: false,
    Tty: false
  };

  internals.logger.info('Starting mocking server...', options);

  internals.dockerRunDetached(state.docker, options, function (error, container) {
    if (error) {
      internals.logger.error('Error while starting mocking server!', error);
    }

    state.containers.ottoMockServer = container;

    next(error, state);
  });
};

internals.tearDown = function (containers, callback) {
  var filter = function (container) {
    if (!container) {
      return false;
    }

    if (!container.instance) {
      return false;
    }

    if (typeof container.instance.remove !== 'function') {
      return false;
    }

    if (container.instance.id === process.env.ELECTRODE_APP_BUILDER) {
      return false;
    }

    return true;
  };

  var map = function (container) {
    return function (next) {
      var options = {
        force: true,
        v: true
      };

      container.instance.remove(options, function (error) {
        if (error) {
          internals.logger.warn('Error while removing container!', error, container);
        }

        next(null, error);
      });
    };
  };

  var tasks = _.chain(containers)
    .filter(filter)
    .map(map)
    .value();

  internals.logger.info('Tearing down...');

  async.series(tasks, callback);
};

internals.testMockServer = function (state, next) {
  if (state.options.mockServerCmd) {
    return internals.startMockServer(state, next);
  }

  internals.logger.info('Skipping mocking server...', state);

  return next(null, state);
};

internals.waitForAppServer = function (state, next) {
  var ip = _.get(state, 'containers.electrodeApp.data.NetworkSettings.Ports["3000/tcp"][0].HostIp');
  var port = _.get(state, 'containers.electrodeApp.data.NetworkSettings.Ports["3000/tcp"][0].HostPort');

  var options = {
    timeout: 5000,
    url: util.format('http://%s:%d', ip, port)
  };

  var onGet = function (error) {
    if (error) {
      internals.logger.error('Application server failed to start!', error);
      return next(error, state);
    }

    internals.logger.info('Application server is up.');
    return next(null, state);
  };

  var onRetry = function (error) {
    return error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED';
  };

  var getRequest = backoff.call(request.get, options, onGet);

  internals.logger.info('Waiting application server to start up...');

  getRequest.retryIf(onRetry);
  getRequest.setStrategy(new backoff.ExponentialStrategy());
  getRequest.failAfter(10);
  getRequest.start();
};

// Run

internals.run();

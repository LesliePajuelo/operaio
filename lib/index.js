#!/usr/bin/env node

'use strict';

// Dependencies

var _ = require('lodash');
var async = require('async');
var Dockerode = require('dockerode');
var fs = require('fs');
var LineWrapper = require('stream-line-wrapper');
var path = require('path');
var request = require('request');
var stream = require('stream');
var yargs = require('yargs');
var url = require('url');
var util = require('util');

// Internal members

var internals = {};

// Constants

internals.SPEED_QUOTES = [
  '"Every car has a lot of speed in it. The trick is getting the speed out of it." AJ Foyt',
  '"I am not a speed reader. I am a speed understander." Isaac Asimov',
  '"If everything seems under control, you\'re not going fast enough." Mario Andretti',
  '"It is not always possible to be the best, but it is always possible to improve your own performance." Jackie Stewart',
  '"Racing is life. Anything before or after is just waiting." Steven McQueen',
  '"Speed provides the one genuinely modern pleasure." Aldous Huxley'
];

// Methods

internals.build = function (state, next) {
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

  if (process.env.ELECTRODE_APP_BUILDER) {
    state.containers.electrodeAppBuilder = {
      instance: {
        id: process.env.ELECTRODE_APP_BUILDER
      }
    };
    return next(null, state);
  }

  return internals.dockerRunAttached(state.docker, options, function (error, container) {
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
  return new Dockerode({
    socketPath: socketPath
  });
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

  return new Dockerode({
    protocol: 'https',
    host: parsedDockerHost.hostname,
    port: parsedDockerHost.port,
    checkServerIdentity: false,
    ca: ca,
    cert: cert,
    key: key
  });
};

internals.dockerRunAttached = function (docker, options, callback) {
  var stream = internals.createLogStream('[OPERAIO] ');

  docker.run(options.Image, options.Cmd, stream, options, function (error, data, container) {
    var statusCode = data && data.StatusCode;

    if (error) {
      return callback(error, {
        instance: container
      });
    }

    if (statusCode !== 0) {
      return callback(new Error(util.format('%s returned status code %d', options.Image, statusCode)), {
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
    .demand('mock-server-cmd')
    .string('mock-server-cmd')
    .default('mock-server-hostname', 'dev.walmart.com')
    .string('mock-server-hostname')
    .default('prefix', 'rapido')
    .string('prefix')
    .default('profile', 'default')
    .string('profile')
    .demand('url')
    .array('url')
    .epilog(internals.getRandomQuote())
    .argv;
};

internals.getRandomQuote = function () {
  var random = _.random(0, internals.SPEED_QUOTES.length - 1);
  return internals.SPEED_QUOTES[random];
};

internals.initialize = function (next) {
  var state = {
    containers: {},
    docker: internals.createDockerClient(),
    options: internals.getOptions()
  };

  next(null, state);
};

internals.onDone = function (error, state) {
  internals.tearDown(state.containers, internals.onDown);
};

internals.onDown = function (error) {
  process.exit(error ? 1 : 0);
};

internals.run = function () {
  async.waterfall([
    internals.initialize,
    internals.build,
    internals.startMockServer,
    internals.startAppServer,
    internals.waitForAppServer,
    internals.runSiteSpeed
  ], internals.onDone);
};

internals.runSiteSpeed = function (state, next) {
  var chromeJsonPath = path.resolve(__dirname, '../volumes/sitespeed/chrome.json');
  var nodeModulesPath = path.resolve(__dirname, '../node_modules');
  var tenant = _.snakeCase(path.join(state.options.githubOrg, state.options.githubRepo));

  var binds = [
    util.format('%s:/tmp/chrome.json', chromeJsonPath),
    util.format('%s:/tmp/node_modules', nodeModulesPath)
  ];

  var cmd = [
    'sitespeed.io',
    '--annessoKairosHost',
    state.options.kairosHost,
    '--annessoPrefix',
    state.options.prefix,
    '--annessoProfile',
    state.options.profile,
    '--annessoTenant',
    tenant,
    '--btConfig',
    '/tmp/chrome.json',
    '--collectors',
    '/tmp/node_modules/@walmart/annesso/lib/collectors',
    '--postTasksDir',
    '/tmp/node_modules/@walmart/annesso/lib/postActions',
    '--seleniumServer',
    'http://0.0.0.0:4444/wd/hub',
    '--verbose',
    '-b',
    'chrome',
    '-d',
    '0',
    '-n',
    '10',
    '-u',
    state.options.url[0]
  ];

  var extraHosts = [
    util.format('dev.walmart.com:%s', state.containers.electrodeApp.data.NetworkSettings.IPAddress)
  ];

  var options = {
    AttachStderr: true,
    AttachStdin: true,
    AttachStdout: true,
    Cmd: cmd,
    HostConfig: {
      Binds: binds,
      ExtraHosts: extraHosts
    },
    Image: 'sitespeedio/sitespeed.io:3.11.5',
    OpenStdin: true,
    StdinOnce: false,
    Tty: true
  };

  internals.dockerRunAttached(state.docker, options, function (error, container) {
    state.containers.siteSpeed = container;
    next(error, state);
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
      ExtraHosts: [
        util.format('dev.walmart.com:%s', state.containers.ottoMockServer.data.NetworkSettings.IPAddress)
      ],
      Links: [
        util.format('%s:otto-mock-server', state.containers.ottoMockServer.data.Name)
      ],
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

  internals.dockerRunDetached(state.docker, options, function (error, container) {
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

  internals.dockerRunDetached(state.docker, options, function (error, container) {
    state.containers.ottoMockServer = container;
    next(error, state);
  });
};

internals.tearDown = function (containers, callback) {
  var filter = function (container) {
    var hasRemove = typeof _.get(container, 'instance.remove') === 'function';
    var isProtected = container && (container.id === process.env.ELECTRODE_APP_BUILDER);
    return hasRemove && !isProtected;
  };

  var map = function (container) {
    return function (next) {
      var options = {
        force: true,
        v: true
      };

      container.instance.remove(options, function () {
        next(null);
      });
    };
  };

  var tasks = _.chain(containers)
    .filter(filter)
    .map(map)
    .value();

  async.parallel(tasks, function () {
    callback(null);
  });
};

internals.waitForAppServer = function (state, next) {
  var host = state.containers.electrodeApp.data.NetworkSettings.Ports['3000/tcp'][0];

  var options = {
    timeout: 5000,
    url: util.format('http://%s:%d', host.HostIp, host.HostPort)
  };

  var onGet = function (error) {
    if (error && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
      return internals.waitForAppServer(state, next);
    }

    return next(error, state);
  };

  request.get(options, onGet);
};

// Run

internals.run();

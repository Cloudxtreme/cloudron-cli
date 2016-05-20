/* jshint node:true */

'use strict';

var assert = require('assert'),
    config = require('./config.js'),
    ejs = require('ejs'),
    EventSource = require('eventsource'),
    fs = require('fs'),
    helper = require('./helper.js'),
    https = require('https'),
    manifestFormat = require('cloudron-manifestformat'),
    opn = require('opn'),
    path = require('path'),
    ProgressBar = require('progress'),
    ProgressStream = require('progress-stream'),
    querystring = require('querystring'),
    readlineSync = require('readline-sync'),
    safe = require('safetydance'),
    spawn = require('child_process').spawn,
    split = require('split'),
    superagent = require('superagent'),
    Table = require('easy-table'),
    util = require('util'),
    _ = require('underscore');

require('colors');

var exit = helper.exit;

exports = module.exports = {
    list: list,
    login: login,
    logout: logout,
    open: open,
    install: install,
    uninstall: uninstall,
    logs: logs,
    exec: exec,
    status: status,
    inspect: inspect,
    pull: pull,
    push: push,
    restart: restart,
    createOAuthAppCredentials: createOAuthAppCredentials,
    init: init,
    restore: restore,
    backup: backup,
    createUrl: createUrl
};

var NO_APP_FOUND_ERROR_STRING = '\nCannot find a matching app.\n' + 'Apps installed from the store are not picked automatically.\n'.gray;

function showDeveloperModeNotice() {
    console.error('CLI mode is disabled. Enable it at %s.'.red, 'https://' + config.apiEndpoint() + '/#/settings');
}

function createUrl(api) {
    return 'https://' + config.apiEndpoint() + api;
}

function ensureLoggedIn() {
    if (!config.has('cloudron', 'token')) exit(util.format('Not setup yet. Please use the ' + 'login'.yellow.bold + ' command first.'));
    else console.error('Using cloudron', config.cloudron().yellow.bold);
}

// takes a function returning a superagent request instance and will reauthenticate in case the token is invalid
function superagentEnd(requestFactory, callback) {
    requestFactory().end(function (error, result) {
        if (!error && result.statusCode === 401) return authenticate({ error: true }, superagentEnd.bind(null, requestFactory, callback));
        callback(error, result);
    });
}

function selectAvailableApp(appId, callback) {
    assert(typeof appId === 'string');
    assert(typeof callback === 'function');

    superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps')).query({ access_token: config.token() }); }, function (error, result) {
        if (error) return callback(error);
        if (result.statusCode !== 200) return callback(util.format('Failed to list apps. %s - %s'.red, result.statusCode, result.text));

        var availableApps = result.body.apps.filter(function (app) {
            return !app.appStoreId && app.manifest.id === appId; // never select apps from the store
        });

        if (availableApps.length === 0) return callback(new Error('No apps installed.'));
        if (availableApps.length === 1) return callback(null, availableApps[0]);

        console.log();
        console.log('Available apps of type %s:', appId);
        availableApps.forEach(function (app, index) {
            console.log('[%s]\t%s', index, app.location);
        });

        var index = -1;
        while (true) {
            index = parseInt(readlineSync.question('Choose app [0-' + (availableApps.length-1) + ']: ', {}), 10);
            if (isNaN(index) || index < 0 || index > availableApps.length-1) console.log('Invalid selection'.red);
            else break;
        }

        callback(null, availableApps[index]);
    });
}

function getApp(appId, callback) {
    if (typeof appId === 'function') {
        callback = appId;
        appId = null;
    }

    ensureLoggedIn();

    var manifestFilePath = helper.locateManifest();

    if (!appId) { // no appid, determine based on manifest path
        if (!manifestFilePath) return callback('No CloudronManifest.json found');

        var manifest = safe.JSON.parse(safe.fs.readFileSync(manifestFilePath));
        if (!manifest) exit('Unable to read manifest.', manifestFilePath, safe.error);

        selectAvailableApp(manifest.id, function (error, result) {
            if (error) return callback(null, null, manifestFilePath);

            callback(null, result, manifestFilePath);
        });
    } else {
        superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() }); }, function (error, result) {
            if (error) return callback(error);
            if (result.statusCode === 503) exit('The Cloudron is currently updating, please retry in a bit.');
            if (result.statusCode === 404) return callback(util.format('App %s not found.', appId.bold));
            if (result.statusCode !== 200) return callback(util.format('Failed to get app.'.red, result.statusCode, result.text));

            callback(null, result.body, manifestFilePath);
        });
    }
}

function getBackup(appId, latest, callback) {
    assert(typeof appId === 'string');
    assert(typeof latest === 'boolean');
    assert(typeof callback === 'function');

    superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps/' + appId + '/backups')).query({ access_token: config.token() }); }, function (error, result) {
        if (error) return callback(error);
        if (result.statusCode === 503) exit('The Cloudron is currently updating, please retry in a bit.');
        if (result.statusCode === 404) return callback(util.format('App %s not found.', appId.bold));
        if (result.statusCode !== 200) return callback(util.format('Failed to get app.'.red, result.statusCode, result.text));

        callback(null, result.body);
    });
}

function getAppNew(callback) {
    var manifestFilePath = helper.locateManifest();

    if (!manifestFilePath) return callback('No CloudronManifest.json found');

    var manifest = safe.JSON.parse(safe.fs.readFileSync(manifestFilePath));
    if (!manifest) exit('Unable to read manifest.', manifestFilePath, safe.error);

    callback(null, null, manifestFilePath);
}

function authenticate(options, callback) {
    console.log();
    console.log('Enter credentials for ' + config.cloudron().bold + ':');
    var username = options.username || readlineSync.question('Username: ', {});
    var password = options.password || readlineSync.question('Password: ', { noEchoBack: true });

    config.unset('token');

    superagent.post(createUrl('/api/v1/developer/login')).send({
        username: username,
        password: password
    }).end(function (error, result) {
        if (error) exit(error);
        if (result.statusCode === 412) {
            showDeveloperModeNotice();
            return authenticate({}, callback);
        }
        if (result.statusCode !== 200) {
            console.log('Login failed.'.red);
            return authenticate({}, callback);
        }

        config.set('token', result.body.token);

        console.log('Login successful.'.green);

        if (typeof callback === 'function') callback();
    });
}

function stopApp(app, callback) {
    assert(typeof app === 'object');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent
        .post(createUrl('/api/v1/apps/' + app.id + '/stop'))
        .query({ access_token: config.token() })
        .send({});
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 202) return exit(util.format('Failed to stop app.'.red, result.statusCode, result.text));

        function waitForFinish(appId) {
            superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() }); }, function (error, result) {
                if (error) exit(error);
                if (result.body.runState === 'stopped') return callback(null);

                process.stdout.write('.');

                setTimeout(waitForFinish.bind(null, appId), 1000);
            });
        }

        process.stdout.write('\n => ' + 'Waiting for app to be stopped '.cyan);
        waitForFinish(app.id);
    });
}

function startApp(app, callback) {
    assert(typeof app === 'object');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent
        .post(createUrl('/api/v1/apps/' + app.id + '/start'))
        .query({ access_token: config.token() })
        .send({});
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 202) return exit(util.format('Failed to start app.'.red, result.statusCode, result.text));

        function waitForFinish(appId) {
            superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() }); }, function (error, result) {
                if (error) exit(error);
                if (result.body.runState === 'running') return callback(null);

                process.stdout.write('.');

                setTimeout(waitForFinish.bind(null, appId), 1000);
            });
        }

        process.stdout.write('\n => ' + 'Waiting for app to be started '.cyan);
        waitForFinish(app.id);
    });
}

function detectCloudronApiEndpoint(cloudron, callback) {
    if (cloudron.indexOf('https://') === 0) cloudron = cloudron.slice('https://'.length);
    if (cloudron.indexOf('my-') === 0) cloudron = cloudron.slice('my-'.length);
    if (cloudron.indexOf('my.') === 0) cloudron = cloudron.slice('my.'.length);
    if (cloudron.indexOf('/') !== -1) cloudron = cloudron.slice(0, cloudron.indexOf('/'));

    superagent.get('https://my-' + cloudron + '/api/v1/cloudron/status').end(function (error, result) {
        if (!error && result.statusCode === 200 && result.body.version) return callback(null, { cloudron: cloudron, apiEndpoint: 'my-' + cloudron });

        superagent.get('https://my.' + cloudron + '/api/v1/cloudron/status').end(function (error, result) {
            if (!error && result.statusCode === 200 && result.body.version) return callback(null, { cloudron: cloudron, apiEndpoint: 'my.' + cloudron });

            callback('Cloudron not found');
        });
    });
}

function login(cloudron, options) {
    cloudron = cloudron || readlineSync.question('Cloudron Hostname: ', {});

    detectCloudronApiEndpoint(cloudron, function (error, result) {
        if (error) exit(error);

        config.set('cloudron', result.cloudron);
        config.set('apiEndpoint', result.apiEndpoint);

        authenticate(options);
    });
}

function logout() {
    config.clear();
    console.log('Logged out.');
}

function open() {
    getApp(null, function (error, app) {
        if (error || !app) exit(NO_APP_FOUND_ERROR_STRING);

        var domain = app.location === '' ? config.cloudron() : (app.location + (config.apiEndpoint().indexOf('my-') === 0 ? '-' : '.') + config.cloudron());
        opn('https://' + domain);
    });
}

function list() {
    ensureLoggedIn();

    superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps')).query({ access_token: config.token() }); }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) return exit(util.format('Failed to list apps. %s - %s'.red, result.statusCode, result.text));

        if (result.body.apps.length === 0) return exit('No apps installed.');

        var t = new Table();

        result.body.apps.forEach(function (app) {
            t.cell('Id', app.id);
            t.cell('Title', app.manifest.title);
            t.cell('Location', app.location);
            t.cell('Version', app.manifest.version);
            t.cell('Manifest Id', app.appStoreId ? app.manifest.id : app.manifest.id + ' (local)');
            t.cell('Install state', app.installationState);
            t.cell('Run state', app.runState);
            t.newRow();
        });

        console.log();
        console.log(t.toString());
    });
}

// Once we have group support also fetch groups here
function getUsersAndGroups(callback) {
    superagentEnd(function () {
        return superagent.get(createUrl('/api/v1/users')).query({ access_token: config.token() });
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) exit(util.format('Failed to get app.'.red, result.statusCode, result.text));

        callback(null, { users: result.body.users, groups: [] });
    });
}

function waitForHealthy(appId, callback) {
    process.stdout.write('\n => ' + 'Wait for health check'.cyan);

    function checkStatus() {
        superagentEnd(function () {
            return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() });
        }, function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(new Error(util.format('Failed to get app.'.red, result.statusCode, result.text)));

            // do not check installation state here. it can be pending_backup etc (this is a bug in box code)
            if (result.body.health === 'healthy') return callback();

            process.stdout.write('.');

            return setTimeout(checkStatus, 1000);
        });
    }

    setTimeout(checkStatus, 1000);
}

function waitForFinishInstallation(appId, waitForHealthcheck, callback) {
    var currentProgress = '';

    function checkStatus() {
        superagentEnd(function () {
            return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() });
        }, function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(new Error(util.format('Failed to get app.'.red, result.statusCode, result.text)));

            // track healthy state after installation
            if (result.body.installationState === 'installed') {
                if (waitForHealthcheck) return waitForHealthy(appId, callback);

                return callback();
            }

            // bail out if there was an error
            if (result.body.installationState === 'error') {
                return callback(new Error(result.body.installationProgress));
            }

            // track current progress and show progress dots
            if (currentProgress === result.body.installationProgress) {
                if (currentProgress && currentProgress.indexOf('Creating image') === -1) process.stdout.write('.');
            } else if (result.body.installationProgress !== null) {
                var tmp = result.body.installationProgress.split(',');
                var installProgressLabel = tmp.length === 2 ? tmp[1] : tmp[0];
                process.stdout.write('\n => ' + installProgressLabel.trim().cyan + ' ');
            } else {
                process.stdout.write('\n => ' + 'Waiting to start installation '.cyan);
            }

            currentProgress = result.body.installationProgress;

            setTimeout(checkStatus, 1000);
        });
    }

    checkStatus();
}

// if app is falsy, we install a new app
// if configure is truthy we will prompt for all settings
function installer(app, configure, manifest, appStoreId, waitForHealthcheck, installLocation, force) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof configure, 'boolean');
    assert.strictEqual(typeof manifest, 'object');
    assert(!appStoreId || typeof appStoreId === 'string');
    assert.strictEqual(typeof waitForHealthcheck, 'boolean');
    assert(!installLocation || typeof installLocation === 'string');
    assert.strictEqual(typeof force, 'boolean');

    getUsersAndGroups(function (error, result) {
        if (error) exit(error);

        var location = typeof installLocation === 'string' ? installLocation : (app ? app.location : null);
        var accessRestriction = app ? app.accessRestriction : null;
        var oauthProxy = app ? app.oauthProxy : false;
        var portBindings = app ? app.portBindings : {};

        // location
        if (location === null) {
            location = readlineSync.question('Location: ', {});
        }

        // oauth proxy
        if (configure) {
            var tmp = readlineSync.question(util.format('Use OAuth Proxy? [y/N]: '), {});
            oauthProxy = tmp.toUpperCase() === 'Y';
        }

        // singleUser
        if (manifest.singleUser && accessRestriction === null) {
            accessRestriction = { users: [ helper.selectUserSync(result.users).id ] };
        }

        // port bindings
        if (configure || (app && !_.isEqual(Object.keys(app.portBindings || { }).sort(), Object.keys(manifest.tcpPorts || { }).sort()))) {
            // ask the user for port values if the ports are different in the app and the manifest
            portBindings = {};
            for (var env in (manifest.tcpPorts || {})) {
                var defaultPort = (app && app.portBindings && app.portBindings[env]) ? app.portBindings[env] : (manifest.tcpPorts[env].defaultValue || '');
                var port = readlineSync.question(manifest.tcpPorts[env].description + ' (default ' + env + '=' + defaultPort + '. "x" to disable): ', {});
                if (port === '') {
                    portBindings[env] = defaultPort;
                } else if (isNaN(parseInt(port, 10))) {
                    console.log(('Cleared ' + env).gray);
                } else {
                    portBindings[env] = parseInt(port, 10);
                }
            }
        } else if (!app) {
            portBindings = {};
            for (var env in (manifest.tcpPorts || {})) {
                portBindings[env] = manifest.tcpPorts[env].defaultValue;
            }
        }

        for (var binding in portBindings) {
            console.log('%s: %s', binding, portBindings[binding]);
        }

        var data = {
            appId: app ? app.id : null, // temporary hack for configure route bug
            appStoreId: appStoreId || '',
            manifest: manifest,
            location: location,
            portBindings: portBindings,
            accessRestriction: accessRestriction,
            oauthProxy: oauthProxy,
            force: force
        };

        var iconFilename = manifest.icon;

        // FIXME: icon file must be read wrt manifest file base dir
        if (iconFilename && iconFilename.slice(0, 7) === 'file://') {
            iconFilename = iconFilename.slice(7);
        }

        var url, message;
        if (!app) {
            url = createUrl('/api/v1/apps/install');
            message = 'installed';
            if (!appStoreId && iconFilename && fs.existsSync(iconFilename)) {
                data.icon = fs.readFileSync(iconFilename).toString('base64');
            }
        } else if (configure || (location !== app.location)) { // cloudron install --location <newloc>
            url = createUrl('/api/v1/apps/' + app.id + '/configure');
            message = 'configured';
        } else {
            url = createUrl('/api/v1/apps/' + app.id + '/update');
            message = 'updated';
            if (!appStoreId && iconFilename && fs.existsSync(iconFilename)) {
                data.icon = fs.readFileSync(iconFilename).toString('base64');
            }
            if (!app.appStoreId) data.force = true; // this allows installation over errored apps (for cli apps)
        }

        superagentEnd(function () {
            var req = superagent.post(url).query({ access_token: config.token() });
            return req.send(data);
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode === 404) exit(util.format('Failed to install app. No such app in the appstore.'.red));
            if (result.statusCode === 409) exit(util.format('Failed to install app. The location %s is already used.'.red, location.bold));
            if (result.statusCode === 403) exit(util.format('Failed to install app. Admin privileges are required.'.red));
            if (result.statusCode !== 202) exit(util.format('Failed to install app. %s (%s)'.red, result.body.message, result.statusCode));

            var appId = app ? app.id : result.body.id;

            console.log('App is being %s with id:', message.bold, appId.bold);

            waitForFinishInstallation(appId, waitForHealthcheck, function (error) {
                if (error && error.message.indexOf('Container command could not be invoked.') > 0) {
                    console.log('\n\nApp installation error: %s'.red, error.message);
                    exit('Is your CMD from the Dockerfile executable?');
                }
                if (error) exit('\n\nApp installation error: %s'.red, error.message);

                console.log('\n\nApp is %s.'.green, message);
                exit();
            });
        });
    });
}

function installFromStore(app, options) {
    var appstoreId = options.appstoreId;
    var parts = appstoreId.split('@');
    if (parts.length !== 2) console.log('No version specified, using latest published version.');

    if (app) {
        console.log('You are installing a published version from the appstore over an existing app at %s.'.yellow, app.location.bold);
        var reallyInstall = readlineSync.question(util.format('Install anyway? [y/N]: '), {});
        if (reallyInstall.toUpperCase() !== 'Y') return exit();
    }

    var url = config.appStoreOrigin() + '/api/v1/apps/' + parts[0] + (parts[1] ? '/versions/' + parts[1] : '');
    superagent.get(url).end(function (error, result) {
        if (error) return exit(util.format('Failed to get app info: %s', error.message));
        if (result.statusCode !== 200) return exit(util.format('Failed to get app info from store.'.red, result.statusCode, result.text));

        installer(app || null, false /* configure */, result.body.manifest, parts[0] /* appStoreId */, !!options.wait, options.location, false /* force */);
    });
}

function install(options) {
    helper.verifyArguments(arguments);

    var func = options.new ? getAppNew : getApp.bind(null, options.app);

    func(function (error, app, manifestFilePath) {
        if (!options.new && error) exit(error);

        if (options.appstoreId) return installFromStore(app, options);

        if (!app) options.new = true; // create new install if we couldn't find an app
        if (!options.new && app) console.log('Reusing app %s installed at %s', app.id.bold, app.location.cyan);

        var result = manifestFormat.parseFile(manifestFilePath);
        if (result.error) return exit('Invalid CloudronManifest.json: '.red + result.error.message);

        var manifest = result.manifest;
        if (manifest.developmentMode && (!app || !app.manifest.developmentMode)) { // developmentMode changed
            console.log('Installing in development mode gives your app unlimited CPU and Memory.'.yellow);
            console.log('This might affect your other apps on this Cloudron.'.yellow);
            var reallyInstall = readlineSync.question(util.format('Install anyway? [y/N]: '), {});
            if (reallyInstall.toUpperCase() !== 'Y') return exit();
        }

        helper.selectImage(manifest, !options.select, function (error, image) {
            if (error) exit('No image found, please run `cloudron build` first or specify a `dockerImage` in the CloudronManifest');

            if (manifest.dockerImage) console.log('Using app image from CloudronManifest %s'.yellow, manifest.dockerImage.cyan);

            manifest.dockerImage = image;

            installer(app, !!options.configure, manifest, null /* appStoreId */, !!options.wait, options.location, !!options.force);
        });
    });
}

function uninstall(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        console.log('Will uninstall app at location %s', app.location.yellow.bold);

        superagentEnd(function () {
            return superagent
            .post(createUrl('/api/v1/apps/' + app.id + '/uninstall'))
            .query({ access_token: config.token() })
            .send({});
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 202) return exit(util.format('Failed to uninstall app.'.red, result.statusCode, result.text));

            function waitForFinish(appId) {
                superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() }); }, function (error, result) {
                    if (error) exit(error);
                    if (result.statusCode === 404) {
                        console.log('\n\nApp %s successfully uninstalled.', appId.bold);
                        exit();
                    }

                    process.stdout.write('.');

                    setTimeout(waitForFinish.bind(null, appId), 1000);
                });
            }

            process.stdout.write('\n => ' + 'Waiting for app to be uninstalled '.cyan);
            waitForFinish(app.id);
        });
    });
}

function logPrinter(obj) {
    var source = obj.source, message;

    if (obj.message === null) {
        message = '[large binary blob skipped]';
    } else if (typeof obj.message === 'string') {
        message = obj.message;
    } else if (util.isArray(obj.message)) {
        message = (new Buffer(obj.message)).toString('utf8');
    }

    var ts = new Date(obj.realtimeTimestamp/1000).toTimeString().split(' ')[0];
    console.log('%s [%s] %s', ts, source.yellow, message);
}

function logs(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        if (!options.tail) {
            superagent.get(createUrl('/api/v1/apps/' + app.id + '/logs'))
                .query({ access_token: config.token(), lines: options.lines || 500 })
                .buffer(false)
                .end(function (error, res) {
                    if (error) return exit(error);

                    res.setEncoding('utf8');
                    res.pipe(split(JSON.parse))
                        .on('data', logPrinter)
                        .on('error', process.exit)
                        .on('end', process.exit);
                });

            return;
        }

        var es = new EventSource(createUrl('/api/v1/apps/' + app.id + '/logstream') + '?lines=10&access_token=' + config.token(),
                                 { rejectUnauthorized: false }); // not sure why this is needed

        es.on('message', function (e) { // e { type, data, lastEventId }. lastEventId is the timestamp
            logPrinter(JSON.parse(e.data));
        });

        es.on('error', function (error) {
            if (error.status === 401) return authenticate({ error: true }, logs.bind(null, options));
            if (error.status === 412) exit('Logs currently not available. App is not installed.');
            exit(error);
        });
    });
}

function status(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        console.log('Id: ', app.id);
        console.log('Location: ', app.location);
        console.log('Version: ', app.manifest.version);
        console.log('Manifest Id: ', app.appStoreId ? app.manifest.id : app.manifest.id + ' (local)');
        console.log('Install state: ', app.installationState);
        console.log('Run state: ', app.runState);

        exit();
   });
}

function inspect(options) {
    helper.verifyArguments(arguments);

    superagent.get(createUrl('/api/v1/apps')).query({ access_token: config.token() }).end(function (error, result) {
        if (error) return exit(error);
        if (result.statusCode === 401) return exit('Use ' + 'cloudron login'.yellow + ' first');
        if (result.statusCode !== 200) return exit(util.format('Failed to list apps. %s - %s'.red, result.statusCode, result.text));

        console.log(JSON.stringify({
            cloudron: config.cloudron(),
            apiEndpoint: config.apiEndpoint(),
            appStoreOrigin: config.appStoreOrigin(),
            apps: result.body.apps
        }, null, options.pretty ? 4 : null));
    });
}

function restart(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        stopApp(app, function (error) {
            if (error) exit(error);

            startApp(app, function (error) {
                if (error) exit(error);

                waitForHealthy(app.id, function (error) {
                    if (error) {
                        return exit('\n\nApp restart error: %s'.red, error.message);
                    }

                    console.log('\n\nApp restarted'.green);

                    exit();
                });
            });
        });
   });
}

function backup(options) {
    helper.verifyArguments(arguments);

    if (options.download) return downloadBackup(options.download);

    if (options.list) return listBackups(options);

    var appId = options.app;

    getApp(appId, function (error, app) {
        if (error) return exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        superagentEnd(function () {
            return superagent
            .post(createUrl('/api/v1/apps/' + app.id + '/backup'))
            .query({ access_token: config.token() })
            .send({});
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 202) return exit(util.format('Failed to backup app.'.red, result.statusCode, result.text));

            // FIXME: this should be waitForHealthCheck but the box code incorrectly modifies the installationState
            waitForFinishInstallation(app.id, true, function (error) {
                if (error) {
                    return exit('\n\nApp backup error: %s'.red, error.message);
                }

                console.log('\n\nApp is backed up'.green);
                exit();
            });
        });
    });
}

function listBoxBackups() {
    superagentEnd(function () {
        return superagent
        .get(createUrl('/api/v1/backups'))
        .query({ access_token: config.token() })
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) return exit(util.format('Failed to list backups.'.red, result.statusCode, result.text));

        var t = new Table();

        result.body.backups.forEach(function (backup) {
            t.cell('Id', backup.id);
            t.cell('Creation Time', backup.creationTime);
            t.cell('Version', backup.version);
            // t.cell('Apps', backup.dependsOn.join(' '));

            t.newRow();
        });

        console.log();
        console.log(t.toString());
    });
}

function listBackups(options) {
    helper.verifyArguments(arguments);

    if (options.box) return listBoxBackups();

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        superagentEnd(function () {
            return superagent
            .get(createUrl('/api/v1/apps/' + app.id + '/backups'))
            .query({ access_token: config.token() })
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 200) return exit(util.format('Failed to list backups.'.red, result.statusCode, result.text));

            var t = new Table();

            result.body.backups.forEach(function (backup) {
                t.cell('Id', backup.id);
                t.cell('Creation Time', backup.creationTime);
                t.cell('Version', backup.version);

                t.newRow();
            });

            console.log();
            console.log(t.toString());
        });
    });
}

function downloadBackup(id) {
    superagentEnd(function () {
        return superagent
        .get(createUrl('/api/v1/backups/' + id))
        .query({ access_token: config.token() })
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) return exit(util.format('Failed to download backup.'.red, result.statusCode, result.text));

        var cmd = 'curl -s -L "' + result.body.url + '" | openssl aes-256-cbc -d -pass pass:' + result.body.backupKey;
        var curl = spawn('sh', [ '-c', cmd ]);

        curl.stdout.pipe(process.stdout);
        curl.stderr.pipe(process.stderr);

        curl.on('close', function (code, signal) {
            exit(code ? 'Error downloading backup' : null);
        });
    });
}

function restore(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        superagentEnd(function () {
            return superagent
            .post(createUrl('/api/v1/apps/' + app.id + '/restore'))
            .query({ access_token: config.token() })
            .send({});
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 202) return exit(util.format('Failed to restore app.'.red, result.statusCode, result.text));

            // FIXME: this should be waitForHealthCheck but the box code incorrectly modifies the installationState
            waitForFinishInstallation(app.id, true, function (error) {
                if (error) {
                    return exit('\n\nApp restore error: %s'.red, error.message);
                }

                console.log('\n\nApp is restored'.green);
                exit();
            });
        });
    });
}

// taken from docker-modem
function demuxStream(stream, stdout, stderr) {
    var header = null;

    stream.on('readable', function() {
        header = header || stream.read(8);
        while (header !== null) {
            var type = header.readUInt8(0);
            var payload = stream.read(header.readUInt32BE(4));
            if (payload === null) break;
            if (type == 2) {
                stderr.write(payload);
            } else {
                stdout.write(payload);
            }
            header = stream.read(8);
        }
    });
};

// cloudron exec - must work interactively. needs tty.
// cloudron exec -- ls asdf  - must work
// cloudron exec -- cat /home/cloudron/start.sh > /tmp/start.sh - must work (test with binary files). should disable tty
// echo "sauce" | cloudron exec -- bash -c "cat - > /app/data/sauce" - test with binary files. should disable tty
// cat ~/tmp/fantome.tar.gz | cloudron exec -- bash -c "tar vf - -C /tmp" - must show an error
// cat ~/tmp/fantome.tar.gz | cloudron exec -- bash -c "tar zxf - -C /tmp" - must extrack ok
function exec(cmd, options) {
    var appId = options.app;
    var stdin = process.stdin; // hack for 'push', 'pull' to reuse this function
    var stdout = options._stdout || process.stdout;

    if (options._stdin) {
        // child_process stream loses data since we connect to 'readable' later
        var bufferStream = new require('stream').PassThrough();
        options._stdin.pipe(bufferStream);
        stdin = bufferStream;
    }

    var trackStdin, tty;

    if ('tty' in options) {
        tty = options.tty;
    } else if (!stdin.isTTY && !stdout.isTTY) { // this is the case when called from scripts
        tty = false;
    } else if (stdin.isTTY && stdout.isTTY) { // called from terminal
        tty = true;
    } else if (!stdin.isTTY) {
        tty = false;
    } else {
        tty = stdout.isTTY;
    }

    if ('trackStdin' in options) {
        trackStdin = options.trackStdin;
    } else if (!stdin.isTTY && !stdout.isTTY) { // called from script
        trackStdin = false; // no way for us to know unless scripts tells us
    } else if (stdin.isTTY && stdout.isTTY) { // called from terminal, always terminate based on remote end
        trackStdin = false; 
    } else if (!stdin.isTTY) { // user is piping a file
        trackStdin = true; // close connection when we are done piping the file
    } else {
        trackStdin = false; // user redirected to file. base it on remote end
    }

    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit(NO_APP_FOUND_ERROR_STRING);

        if (cmd.length === 0) {
            tty = true; // override

            cmd = [ '/bin/bash' ];
        }

        if (tty && !stdin.isTTY) exit('stdin is not tty');

        var query = {
            rows: stdout.rows,
            columns: stdout.columns,
            access_token: config.token(),
            cmd: JSON.stringify(cmd),
            tty: tty
        };

        var req = https.request({
            hostname: config.apiEndpoint(),
            path: '/api/v1/apps/' + app.id + '/exec?' + querystring.stringify(query),
            method: 'GET',
            headers: {
              'Connection': 'Upgrade',
              'Upgrade': 'tcp'
            },
            rejectUnauthorized: false
        }, function handler(res) {
            if (res.statusCode === 412) {
                showDeveloperModeNotice();
                exit();
            }
            if (res.statusCode === 403) exit('Only admins can use this feature.'.red);

            exit('Could not upgrade connection to tcp. http status:', res.statusCode);
        });

        req.on('upgrade', function (resThatShouldNotBeUsed, socket, upgradeHead) {
            // do not use res here! it's all socket from here on
            socket.on('end', exit); // server closed the socket
            socket.on('error', exit);

            socket.setNoDelay(true);
            socket.setKeepAlive(true);

            if (tty) {
                if (stdin.setRawMode) stdin.setRawMode(true); // required because --tty can be passed in options
                stdin.pipe(socket, { end: trackStdin });
                socket.pipe(stdout);
            } else {
                stdin.pipe(socket, { end: trackStdin });
                demuxStream(socket, stdout, process.stderr);
            }
        });

        req.on('error', exit); // could not make a request
        req.end(); // this makes the request
    });
}

function push(local, remote, options) {
    var stat = fs.existsSync(local) ? fs.lstatSync(local) : null;

    options.trackStdin = true; // close socket when stdin is done

    if (stat && stat.isDirectory())  {
        var tarStream = spawn('tar', ['zcvf', '-', '-C', path.dirname(local), path.basename(local)], { stdio: [ 'pipe', 'pipe', 'inherit' ] });
        options._stdin = tarStream.stdout;
        tarStream.on('close', function (code) { if (code) exit('Error pushing', code); });

        exec(['tar', 'zxvf', '-', '-C', remote], options);
    } else {
        if (local === '-') {
            options._stdin = process.stdin;
        } else if (stat) {
            var progress = new ProgressStream({ length: stat.size, time: 1000 });

            options._stdin = progress;
            fs.createReadStream(local).pipe(progress);

            var bar = new ProgressBar('Uploading [:bar] :percent: :etas', {
                complete: '=',
                incomplete: ' ',
                width: 100,
                total: stat.size
            });

            progress.on('progress', function (p) { bar.update(p.percentage / 100); /* bar.tick(p.transferred - bar.curr); */ });
        } else {
            exit('local file ' + local + ' does not exist');
        }

        options._stdin.on('error', function (error) { exit('Error pushing', error); });

        if (remote.endsWith('/')) { // dir
            remote = path.join(remote, path.basename(local));
        }

        exec(['bash', '-c', 'cat - > ' + remote], options);
    }
}

function pull(remote, local, options) {
    if (remote.endsWith('/')) { // dir
        var tarStream = spawn('tar', ['zxvf', '-', '-C', local]);
        options._stdout = tarStream.stdin;
        tarStream.on('close', function (code) { exit('Error pulling', code); });

        exec(['tar', 'zcf', '-', '-C', remote, '.'], options);
    } else {
        if (fs.existsSync(local) && fs.lstatSync(local).isDirectory()) {
            local = path.join(local, path.basename(remote));
        } else if (local === '-') {
            options._stdout = process.stdout;
        } else {
            options._stdout = fs.createWriteStream(local);
        }

        options._stdout.on('error', function (error) { exit('Error pulling', error); });

        exec(['cat', remote], options);
    }
}

function createOAuthAppCredentials(options) {
    ensureLoggedIn();

    var redirectURI = options.redirectUri || readlineSync.question('RedirectURI: ', {});

    superagentEnd(function () {
        return superagent
        .post(createUrl('/api/v1/oauth/clients'))
        .query({ access_token: config.token() })
        .send({ appId: 'localdevelopment', redirectURI: redirectURI, scope: options.scope });
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 201) return exit(util.format('Failed to create oauth app credentials.'.red, result.statusCode, result.text));

        if (options.shell) {
            console.log('CLOUDRON_CLIENT_ID="%s"', result.body.id);
            console.log('CLOUDRON_CLIENT_SECRET="%s"', result.body.clientSecret);
            console.log('CLOUDRON_REDIRECT_URI="%s"', result.body.redirectURI);
        } else {
            console.log();
            console.log('New oauth app credentials');
            console.log('ClientId:     %s', result.body.id.cyan);
            console.log('ClientSecret: %s', result.body.clientSecret.cyan);
            console.log('RedirectURI:  %s', result.body.redirectURI.cyan);
            console.log();
            console.log('apiOrigin: %s', 'https://' + config.apiEndpoint());
            console.log('authorizationURL: %s', 'https://' + config.apiEndpoint() + '/api/v1/oauth/dialog/authorize');
            console.log('tokenURL:         %s', 'https://' + config.apiEndpoint() + '/api/v1/oauth/token');
        }
    });
}

function init() {
    var manifestFilePath = helper.locateManifest();
    if (path.dirname(manifestFilePath) === process.cwd()) return exit('CloudronManifest.json already exists in current directory'.red);

    var manifestTemplate = fs.readFileSync(__dirname + '/CloudronManifest.json.ejs', 'utf8');
    var dockerfileTemplate = fs.readFileSync(__dirname + '/Dockerfile.ejs', 'utf8');
    var descriptionTemplate = fs.readFileSync(__dirname + '/DESCRIPTION.md.ejs', 'utf8');
    var dockerignoreTemplate = fs.readFileSync(__dirname + '/dockerignore.ejs', 'utf8');
    var changelogTemplate = fs.readFileSync(__dirname + '/CHANGELOG.ejs', 'utf8');

    var data = {
        version: '0.0.1'
    };

    // TODO more input validation, eg. httpPort has to be an integer
    [ 'id', 'author', 'title', 'tagline', 'website', 'contactEmail', 'httpPort' ].forEach(function (field) {
        data[field] = readlineSync.question(field + ': ', { });
    });

    var manifest = ejs.render(manifestTemplate, data);
    fs.writeFileSync('CloudronManifest.json', manifest, 'utf8');

    if (fs.existsSync('Dockerfile')) {
        console.log('Dockerfile already exists, skipping');
    } else {
        var dockerfile = ejs.render(dockerfileTemplate, data);
        fs.writeFileSync('Dockerfile', dockerfile, 'utf8');
    }

    if (fs.existsSync('DESCRIPTION.md')) {
        console.log('DESCRIPTION.md already exists, skipping');
    } else {
        var description = ejs.render(descriptionTemplate, data);
        fs.writeFileSync('DESCRIPTION.md', description, 'utf8');
    }

    if (fs.existsSync('.dockerignore')) {
        console.log('.dockerignore already exists, skipping');
    } else {
        var dockerignore = ejs.render(dockerignoreTemplate, data);
        fs.writeFileSync('.dockerignore', dockerignore, 'utf8');
    }

    if (fs.existsSync('CHANGELOG')) {
        console.log('CHANGELOG already exists, skipping');
    } else {
        var changelog = ejs.render(changelogTemplate, data);
        fs.writeFileSync('CHANGELOG', changelog, 'utf8');
    }
}

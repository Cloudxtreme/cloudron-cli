/* jshint node:true */

'use strict';

var superagent = require('superagent'),
    util = require('util'),
    path = require('path'),
    assert = require('assert'),
    opn = require('opn'),
    fs = require('fs'),
    safe = require('safetydance'),
    Table = require('easy-table'),
    readlineSync = require('readline-sync'),
    config = require('./config.js'),
    helper = require('./helper.js'),
    exit = helper.exit,
    https = require('https'),
    querystring = require('querystring'),
    manifestFormat = require('cloudron-manifestformat'),
    ejs = require('ejs'),
    EventSource = require('eventsource'),
    _ = require('underscore');

require('colors');

exports = module.exports = {
    list: list,
    login: login,
    logout: logout,
    open: open,
    install: install,
    uninstall: uninstall,
    logs: logs,
    exec: exec,
    info: info,
    restart: restart,
    createOAuthAppCredentials: createOAuthAppCredentials,
    init: init,
    restore: restore,
    backup: backup
};

function showDeveloperModeNotice() {
    console.log('Please enable the developer mode on your Cloudron first.'.red);
    console.log('You have to login to %s and enable it in your account settings.', 'https://my-' + config.cloudron() + '/#/settings');
}

function createUrl(api) {
    return 'https://my-' + config.cloudron() + api;
}

function ensureLoggedIn() {
    if (!config.has('cloudron', 'token')) exit(util.format('Not setup yet. Please use the ' + 'login'.yellow.bold + ' command first.'));
    else console.log('Using cloudron', config.cloudron().yellow.bold);
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
            return app.manifest.id === appId;
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
            index = parseInt(readlineSync.question('Choose app [0-' + (availableApps.length-1) + ']: ', {}));
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

                setTimeout(waitForFinish.bind(null, appId), 250);
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

                setTimeout(waitForFinish.bind(null, appId), 250);
            });
        }

        process.stdout.write('\n => ' + 'Waiting for app to be started '.cyan);
        waitForFinish(app.id);
    });
}

function login(cloudron, options) {
    cloudron = cloudron || readlineSync.question('Cloudron Hostname: ', {});

    if (cloudron.indexOf('https://') === 0) cloudron = cloudron.slice('https://'.length);
    if (cloudron.indexOf('my-') === 0) cloudron = cloudron.slice('my-'.length);
    if (cloudron.indexOf('/') !== -1) cloudron = cloudron.slice(0, cloudron.indexOf('/'));

    config.set('cloudron', cloudron);

    authenticate(options);
}

function logout(cmd, options) {
    config.clear();
    console.log('Done.');
}

function open() {
    getApp(null, function (error, app, manifestFilePath) {
        if (error || !app) exit('No app found');

        // TODO handle custom domains
        var domain = app.location === '' ? config.cloudron() : (app.location + '-' + config.cloudron());
        opn('https://' + domain);
    });
}

function list(options) {
    ensureLoggedIn();

    superagentEnd(function () { return superagent.get(createUrl('/api/v1/apps')).query({ access_token: config.token() }); }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) return exit(util.format('Failed to list apps. %s - %s'.red, result.statusCode, result.text));

        if (result.body.apps.length === 0) return console.log('No apps installed.');

        var t = new Table();

        result.body.apps.forEach(function (app) {
            t.cell('Store', app.appStoreId ? 'Yes' : 'No');
            t.cell('Title', app.manifest.title);
            t.cell('Version', app.manifest.version);
            t.cell('Location', app.location);
            t.cell('Id', app.id);
            t.cell('Manifest Id', app.manifest.id);
            t.cell('Install state', app.installationState);
            t.cell('Run state', app.runState);
            t.newRow();
        });

        console.log();
        console.log(t.toString());
    });
}

function waitForFinishInstallation(appId, waitForHealthcheck, callback) {
    var currentProgress = '';
    var waitingForHealthcheck = false;

    function checkStatus() {
        superagentEnd(function () {
            return superagent.get(createUrl('/api/v1/apps/' + appId)).query({ access_token: config.token() });
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 200) exit(util.format('Failed to get app.'.red, result.statusCode, result.text));

            // track healthy state after installation
            if (result.body.installationState === 'installed') {
                if (!waitForHealthcheck || result.body.health === 'healthy') {
                    return callback(null);
                } else {
                    if (waitingForHealthcheck) {
                        process.stdout.write('.');
                    } else {
                        waitingForHealthcheck = true;
                        process.stdout.write('\n => ' + 'Wait for health check'.cyan);
                    }

                    return setTimeout(checkStatus, 100);
                }
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

            setTimeout(checkStatus, 100);
        });
    }

    checkStatus();
}

// if app is falsy, we install a new app
// if configure is truthy we will prompt for all settings
function installer(app, configure, manifest, waitForHealthcheck) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof configure, 'boolean');
    assert.strictEqual(typeof manifest, 'object');
    assert.strictEqual(typeof waitForHealthcheck, 'boolean');

    var location = app ? app.location : null;
    var accessRestriction = app ? app.accessRestriction : '';
    var portBindings = app ? app.portBindings : {};

    // location
    if (configure || location === null) {
        location = readlineSync.question('Location: ', {});
    }

    // access restriction
    if (configure) {
        var tmp = readlineSync.question('Restriction (NONE/admin/user)): ', {});

        switch (tmp.toLowerCase()) {
            case '': case 'none': accessRestriction = ''; break;
            case 'admin': accessRestriction = 'roleAdmin'; break;
            case 'user': accessRestriction = 'roleUser'; break;
            default: exit('invalid access restriction');
        }
    }

    // port bindings
    if (configure || (app && !_.isEqual(Object.keys(app.portBindings || { }).sort(), Object.keys(manifest.tcpPorts || { }).sort()))) {
        // ask the user for port values if the ports are different in the app and the manifest
        portBindings = {};
        for (var env in (manifest.tcpPorts || {})) {
            var defaultPort = (app && app.portBindings && app.portBindings[env]) ? app.portBindings[env] : (manifest.tcpPorts[env].defaultValue || '');
            var port = readlineSync.question(manifest.tcpPorts[env].description + ' (default ' + env + '=' + defaultPort + '): ', {});
            if (port === '') {
                portBindings[env] = defaultPort;
            } else if (isNaN(parseInt(port, 10))) {
                console.log('Cleared port'.gray);
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
        appStoreId: '',
        manifest: manifest,
        location: location,
        portBindings: portBindings,
        accessRestriction: accessRestriction
    };

    var url, message;
    if (!app) {
        url = createUrl('/api/v1/apps/install');
        message = 'installed';
        if (manifest.icon && fs.existsSync(manifest.icon)) { // may not exist for appstore-id case
            data.icon = fs.readFileSync(manifest.icon).toString('base64');
        }
    } else if (configure) {
        url = createUrl('/api/v1/apps/' + app.id + '/configure');
        message = 'configured';
    } else {
        url = createUrl('/api/v1/apps/' + app.id + '/update');
        message = 'updated';
        if (manifest.icon && fs.existsSync(manifest.icon)) { // may not exist for appstore-id case
            data.icon = fs.readFileSync(manifest.icon).toString('base64');
        }
    }

    superagentEnd(function () {
        var req = superagent.post(url).query({ access_token: config.token() });
        return req.send(data);
    }, function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 202) exit(util.format('Failed to install app.'.red, result.statusCode, result.text));

        var appId = app ? app.id : result.body.id;

        console.log('App is being %s with id:', message.bold, appId.bold);

        waitForFinishInstallation(appId, waitForHealthcheck, function (error) {
            if (error) {
                return exit('\n\nApp installation error: %s'.red, error.message);
            }

            console.log('\n\nApp is %s.'.green, message);
            exit();
        });
    });
}

function installFromStore(options) {
    var appstoreId = options.appstoreId;
    var parts = appstoreId.split('@');
    if (parts.length !== 2) exit('--appstore-id must be of the form id@version');

    superagent.get(config.appStoreOrigin() + '/api/v1/apps/' + parts[0] + '/versions/' + parts[1])
        .end(function (error, result) {
        if (error) return exit(util.format('Failed to get app info: %s', error.message));
        if (result.statusCode !== 200) return exit(util.format('Failed to get app info from store.'.red, result.statusCode, result.text));

        installer(null /* app */, false /* configure */, result.body.manifest, !!options.wait);
    });
}

function install(options) {
    helper.verifyArguments(arguments);

    if (options.appstoreId) return installFromStore(options);

    var func;
    if (options.new) func = getAppNew;
    else func = getApp;

    func(function (error, app, manifestFilePath) {
        if (!options.new && error) exit(error);

        if (!app) options.new = true; // create new install if we couldn't find an app
        if (!options.new && app) console.log('Reusing app %s installed at %s', app.id.bold, app.location.cyan);

        var result = manifestFormat.parseFile(manifestFilePath);
        if (result.error) return exit('Invalid CloudronManifest.json: '.red + result.error.message);

        var manifest = result.manifest;

        helper.selectImage(manifest, !options.select, function (error, image) {
            if (error) exit('No image found, please run `cloudron build` first or specify a `dockerImage` in the CloudronManifest');

            if (manifest.dockerImage) console.log('Using app image from CloudronManifest %s'.yellow, manifest.dockerImage.cyan);

            manifest.dockerImage = image;

            installer(app, !!options.configure, manifest, !!options.wait);
        });
    });
}

function uninstall(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('No installed app here');

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

                    setTimeout(waitForFinish.bind(null, appId), 250);
                });
            }

            process.stdout.write('\n => ' + 'Waiting for app to be uninstalled '.cyan);
            waitForFinish(app.id);
        });
    });
}

function logs(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('Cannot find any installed app');

        if (!options.tail) {
            superagent.get(createUrl('/api/v1/apps/' + app.id + '/logs'))
                .query({ access_token: config.token() })
                .on('error', exit)
                .pipe(process.stdout);
            return;
        }

        var es = new EventSource(createUrl('/api/v1/apps/' + app.id + '/logstream') + '?fromLine=-10&access_token=' + config.token(),
                                 { rejectUnauthorized: false }); // not sure why this is needed

        es.on('message', function (e) { // e { type, data, lastEventId }. lastEventId is the line number
            var l = safe.JSON.parse(e.data); // lineNumber, timestamp, log
            console.log("%s %s", l.timestamp.gray, l.log);
        });

        es.on('error', function (error) {
            if (error.status === 401) return authenticate({ error: true }, logs.bind(null, options));
            if (error.status === 412) exit('Logs currently not available. App is not installed.');
            exit(error);
        });
    });
}

function info(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('No installed app here');

        console.log(util.inspect(app, { depth: null }));
        exit();
   });
}

function restart(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('No installed app here');

        stopApp(app, function (error) {
            if (error) exit(error);

            startApp(app, function (error) {
                if (error) exit(error);

                console.log('\n');
            });
        });
   });
}

function backup(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) return exit(error);

        if (!app) return exit('No installed app here');

        superagentEnd(function () {
            return superagent
            .post(createUrl('/api/v1/apps/' + app.id + '/backup'))
            .query({ access_token: config.token() })
            .send({});
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 202) return exit(util.format('Failed to backup app.'.red, result.statusCode, result.text));

            console.log('Backup initiated'.green);
        });
    });
}

function restore(options) {
    helper.verifyArguments(arguments);

    var appId = options.app;
    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('No installed app here');

        superagentEnd(function () {
            return superagent
            .post(createUrl('/api/v1/apps/' + app.id + '/restore'))
            .query({ access_token: config.token() })
            .send({});
        }, function (error, result) {
            if (error) exit(error);
            if (result.statusCode !== 202) return exit(util.format('Failed to restore app.'.red, result.statusCode, result.text));

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

function exec(cmd, options) {
    var appId = options.app;

    if (!process.stdin.isTTY) exit('stdin is not tty');

    getApp(appId, function (error, app) {
        if (error) exit(error);

        if (!app) exit('No installed app here');

        if (cmd.length === 0) cmd = [ '/bin/bash' ];

        var query = {
            rows: process.stdout.rows,
            columns: process.stdout.columns,
            access_token: config.token(),
            cmd: JSON.stringify(cmd)
        };

        var req = https.request({
            hostname: 'my-' + config.cloudron(),
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

            exit('Could not upgrade connection to tcp. http status:', res.statusCode);
        });

        req.on('upgrade', function (resThatShouldNotBeUsed, socket, upgradeHead) {
            // do not use res here! it's all socket from here on
            socket.on('end', exit); // server closed the socket
            socket.on('error', exit);

            socket.setNoDelay(true);
            socket.setKeepAlive(true);

            socket.pipe(process.stdout);

            process.stdin.resume();
            process.stdin.setEncoding('utf8');
            process.stdin.setRawMode(true);
            process.stdin.pipe(socket);
        });

        req.on('error', exit); // could not make a request
        req.end(); // this makes the request
    });
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

        console.log();
        console.log('New oauth app credentials');
        console.log('ClientId:     %s', result.body.id.cyan);
        console.log('ClientSecret: %s', result.body.clientSecret.cyan);
        console.log('RedirectURI:  %s', result.body.redirectURI.cyan);
        console.log();
        console.log('authorizationURL: %s', 'https://my-' + config.cloudron() + '/api/v1/oauth/dialog/authorize');
        console.log('tokenURL:         %s', 'https://my-' + config.cloudron() + '/api/v1/oauth/token');
    });
}

function init() {
    var manifestFilePath = helper.locateManifest();
    if (path.dirname(manifestFilePath) === process.cwd()) return exit('CloudronManifest.json already exists in current directory'.red);

    var manifestTemplate = fs.readFileSync(__dirname + '/CloudronManifest.json.ejs', 'utf8');
    var dockerfileTemplate = fs.readFileSync(__dirname + '/Dockerfile.ejs', 'utf8');

    var data = { };

    // TODO more input validation, eg. httpPort has to be an integer
    [ 'id', 'author', 'title', 'description', 'tagline', 'website', 'contactEmail', 'httpPort' ].forEach(function (field) {
        data[field] = readlineSync.question(field + ': ', { });
    });

    var manifest = ejs.render(manifestTemplate, data);
    fs.writeFileSync('CloudronManifest.json', manifest, 'utf8');

    if (fs.existsSync('Dockerfile')) {
        console.log('A Dockerfile already exists. Skip creating one.');
        return;
    }

    var dockerfile = ejs.render(dockerfileTemplate, data);
    fs.writeFileSync('Dockerfile', dockerfile, 'utf8');
}


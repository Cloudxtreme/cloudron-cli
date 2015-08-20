/* jshint node:true */

'use strict';

var superagent = require('superagent'),
    util = require('util'),
    path = require('path'),
    assert = require('assert'),
    fs = require('fs'),
    safe = require('safetydance'),
    Table = require('easy-table'),
    readlineSync = require('readline-sync'),
    config = require('./config.js'),
    tar = require('tar-fs'),
    helper = require('./helper.js'),
    exit = helper.exit,
    EventSource = require('eventsource'),
    manifestFormat = require('cloudron-manifestformat'),
    semver = require('semver'),
    split = require('split');

require('colors');

exports = module.exports = {
    login: login,
    logout: logout,
    info: info,
    listVersions: listVersions,
    publish: publish,
    unpublish: unpublish,
    build: build,
    buildLogs: buildLogs
};

function createUrl(api) {
    return config.appStoreOrigin() + api;
}

// takes a function returning a superagent request instance and will reauthenticate in case the token is invalid
function superagentEnd(requestFactory, callback) {
    requestFactory().end(function (error, result) {
        if (error) return callback(error);
        if (result.statusCode === 401) return authenticate({ error: true }, superagentEnd.bind(null, requestFactory, callback));
        if (result.statusCode === 403) return callback(result.body);
        callback(error, result);
    });
}

function authenticate(options, callback) {
    console.log();
    console.log('Appstore login:'.bold);
    var username = options.username || readlineSync.question('Email: ', {});
    var password = readlineSync.question('Password: ', { noEchoBack: true });

    config.unset('appStoreToken');

    superagent.get(createUrl('/api/v1/login')).auth(username, password).end(function (error, result) {
        if (error) exit(error);
        if (result.statusCode !== 200) {
            console.log('Login failed.'.red);
            return authenticate({}, callback);
        }

        config.set('appStoreToken', result.body.accessToken);

        console.log('Login successful.'.green);

        if (typeof callback === 'function') callback();
    });
}

function login(options) {
    authenticate(options);
}

function logout(options) {
    config.unset('appStoreToken');
    console.log('Done.'.green);
}

function listApps(options) {
    superagentEnd(function () {
        return superagent.get(createUrl('/api/v1/developers/apps')).query({ accessToken: config.appStoreToken() });
    }, function (error, result) {
        if (error) exit(util.format('Failed to list apps: %s', error.message.red));
        if (result.statusCode !== 200) exit(util.format('Failed to list apps: %s message: %s', result.statusCode, result.text));

        if (result.body.apps.length === 0) return console.log('No apps installed.');

        var t = new Table();

        result.body.apps.forEach(function (app) {
            t.cell('Id', app.id);
            t.cell('Title', app.manifest.title);
            t.cell('Latest Version', app.manifest.version);
            t.cell('Publish State', app.publishState);
            t.cell('Creation Date', app.creationDate);
            t.newRow();
        });

        console.log();
        console.log(t.toString());
    });
}

function info(app) {
    helper.getAppStoreId(app, function (error, appStoreId) {
        if (error) exit(error);
        if (!appStoreId) exit('This project is not linked to any application in the store. Use the ' + 'link'.yellow.bold + ' command first.');

        superagentEnd(function () {
            return superagent.get(createUrl('/api/v1/developers/apps/' + appStoreId)).query({ accessToken: config.appStoreToken() });
        }, function (error, result) {
            if (error) exit(util.format('Failed to list apps: %s', error.message.red));
            if (result.statusCode !== 200) exit(util.format('Failed to list apps: %s message: %s', result.statusCode, result.text));

            console.log(result.body);
        });
    });
}

function listVersions(options) {
    helper.verifyArguments(arguments);

    if (options.apps) return listApps(options);

    helper.getAppStoreId(options.app, function (error, appStoreId) {
        if (error) exit(error);
        if (!appStoreId) exit('This project is not linked to any application in the store. Use the ' + 'link'.yellow.bold + ' command first.');

        superagentEnd(function () {
            return superagent.get(createUrl('/api/v1/developers/apps/' + appStoreId + '/versions')).query({ accessToken: config.appStoreToken() });
        }, function (error, result) {
            if (error) exit(util.format('Failed to list versions: %s', error.message.red));
            if (result.statusCode !== 200) exit(util.format('Failed to list versions: %s message: %s', result.statusCode, result.text));

            if (result.body.versions.length === 0) return console.log('No versions found.');

            if (options.raw) return console.log(JSON.stringify(result.body.versions, null, 2));

            var versions = result.body.versions.reverse();

            var manifest = versions[0].manifest;
            console.log('id: %s', versions[0].id.bold);
            console.log('title: %s', manifest.title.bold);
            console.log('tagline: %s', manifest.tagline.bold);
            console.log('description: %s', manifest.description.bold);
            console.log('website: %s', manifest.website.bold);
            console.log('contactEmail: %s', manifest.contactEmail.bold);

            var t = new Table();

            versions.forEach(function (version) {
                t.cell('Version', version.manifest.version);
                t.cell('Creation Date', version.creationDate);
                t.cell('Publish state', version.publishState);
                t.newRow();
            });

            console.log();
            console.log(t.toString());
        });
    });
}

function addApp(manifest, baseDir, callback) {
    assert(typeof manifest === 'object');
    assert(typeof baseDir === 'string');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent.post(createUrl('/api/v1/developers/apps'))
        .query({ accessToken: config.appStoreToken() })
        .send({ id: manifest.id });
    }, function (error, result) {
        if (error) return exit(util.format('Failed to create app: %s', error.message.red));
        if (result.statusCode !== 201 && result.statusCode !== 409) {
            return exit(util.format('Failed to create app: %s message: %s', result.statusCode, result.text));
        }

        if (result.statusCode === 201) {
            console.log('New application added to the appstore with id %s.'.green, manifest.id);
        }

        callback();
    });
}

function addVersion(manifest, buildId, baseDir) {
    assert(typeof manifest === 'object');
    assert(typeof buildId === 'string');
    assert(typeof baseDir === 'string');

    var iconFilePath = null;
    if (manifest.icon) {
        var iconFile = manifest.icon; // backward compat
        if (iconFile.slice(0, 7) === 'file://') icon = iconFile.slice(7);

        iconFilePath = path.isAbsolute(iconFile) ? iconFile : path.join(baseDir, iconFile);
        if (!fs.existsSync(iconFilePath)) return exit('icon not found at ' + iconFilePath);
    }

    if (manifest.description.slice(0, 7) === 'file://') {
        var descriptionFilePath = manifest.description.slice(7);
        manifest.description = safe.fs.readFileSync(descriptionFilePath, 'utf8');
        if (!manifest.description) return exit('Could not read description ' + safe.error.message);
    }

    superagentEnd(function () {
        var req = superagent.post(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions'));
        req.query({ accessToken: config.appStoreToken() });
        if (iconFilePath) req.attach('icon', iconFilePath);
        req.field('buildId', buildId);
        req.attach('manifest', new Buffer(JSON.stringify(manifest)), { filename: 'manifest' });
        return req;
    }, function (error, result) {
        if (error) return exit(util.format('Failed to publish version: %s', error.message.red));
        if (result.statusCode !== 204) exit(util.format('Failed to publish version (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        console.log('New version published.'.green);
    });
}

function updateVersion(manifest, buildId, baseDir) {
    assert(typeof manifest === 'object');
    assert(typeof buildId === 'string');
    assert(typeof baseDir === 'string');

    var iconFilePath = null;
    if (manifest.icon) {
        var iconFile = manifest.icon; // backward compat
        if (iconFile.slice(0, 7) === 'file://') icon = iconFile.slice(7);

        iconFilePath = path.isAbsolute(iconFile) ? iconFile : path.join(baseDir, iconFile);
        if (!fs.existsSync(iconFilePath)) return exit('icon not found at ' + iconFilePath);
    }

    if (manifest.description.slice(0, 7) === 'file://') {
        var descriptionFilePath = manifest.description.slice(7);
        manifest.description = safe.fs.readFileSync(descriptionFilePath, 'utf8');
        if (!manifest.description) return exit('Could not read description ' + safe.error.message);
    }

    superagentEnd(function () {
        var req = superagent.put(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions/' + manifest.version));
        req.query({ accessToken: config.appStoreToken() });
        if (iconFilePath) req.attach('icon', iconFilePath);
        req.field('buildId', buildId);
        req.attach('manifest', new Buffer(JSON.stringify(manifest)), { filename: 'manifest' });
        return req;
    }, function (error, result) {
        if (error) return exit(util.format('Failed to publish version: %s', error.message.red));
        if (result.statusCode !== 204) exit(util.format('Failed to publish version (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        console.log('Version updated.'.green);
    });
}

function delVersion(manifest, force) {
    assert(typeof manifest === 'object');
    assert(typeof force === 'boolean');

    if (!force) {
        console.log('This will delete the version %s of app %s from the appstore!'.red, manifest.version.bold, manifest.id.bold);
        var reallyDelete = readlineSync.question(util.format('Really do this? [y/N]: '), {});
        if (reallyDelete.toUpperCase() !== 'Y') exit();
    }

    superagentEnd(function () {
        return superagent.del(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions/' + manifest.version)).query({ accessToken: config.appStoreToken() });
    }, function (error, result) {
        if (error) return exit(util.format('Failed to unpublish version: %s', error.message.red));
        if (result.statusCode !== 204) exit(util.format('Failed to unpublish version (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        console.log('version unpublished.'.green);
    });
}

function delApp(appId, force) {
    assert(typeof appId === 'string');
    assert(typeof force === 'boolean');

    if (!force) {
        console.log('This will delete app %s from the appstore!'.red, appId.bold);
        var reallyDelete = readlineSync.question(util.format('Really do this? [y/N]: '), {});
        if (reallyDelete.toUpperCase() !== 'Y') exit();
    }

    superagentEnd(function () {
        return superagent.del(createUrl('/api/v1/developers/apps/' + appId)).query({ accessToken: config.appStoreToken() });
    }, function (error, result) {
        if (error) return exit(util.format('Failed to unpublish app: %s', error.message.red));
        if (result.statusCode !== 204) exit(util.format('Failed to unpublish app (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        console.log('App unpublished.'.green);
    });
}

function submitAppForReview(manifest, callback) {
    assert(typeof manifest === 'object');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent.post(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions/' + manifest.version + '/submit'))
        .query({ accessToken: config.appStoreToken() })
        .send({ });
    }, function (error, result) {
        if (error) return exit(util.format('Failed to submit app for review: %s', error.message.red));
        if (result.statusCode !== 200) return exit(util.format('Failed to submit app (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        console.log('App submitted for review'.green);

        callback();
    });
}

function publish(options) {
    helper.verifyArguments(arguments);

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit(result.error.message);

    var manifest = result.manifest;

    if (options.submit) return submitAppForReview(manifest, exit);

    // ensure the app is known on the appstore side
    addApp(manifest, path.dirname(manifestFilePath), function () {
        console.log();
        console.log('Building %s@%s', manifest.id.bold, manifest.version.bold);
        console.log();

        helper.selectBuild(manifest.id, true /* latest */, function (error, build) {
            if (error || !build.dockerImage) exit('No build found, please run `cloudron build` first and test the new build on your Cloudron.');

            console.log('Publishing %s@%s with build %s.', manifest.id, manifest.version, build.id);

            if (options.force) {
                updateVersion(manifest, build.id, path.dirname(manifestFilePath));
            } else {
                addVersion(manifest, build.id, path.dirname(manifestFilePath));
            }
        });
    });
}

function unpublish(options) {
    helper.verifyArguments(arguments);

    if (options.app) {
        console.log('Unpublishing ' + options.app);
        delApp(options.app, !!options.force);
        return;
    }

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit(result.error.message);

    var manifest = result.manifest;

    console.log('Unpublishing ' + manifest.id + '@' + manifest.version);
    delVersion(manifest, !!options.force);
}

function getBuildInfo(buildId, callback) {
    assert(typeof buildId === 'string');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent.get(createUrl('/api/v1/developers/builds/' + buildId)).query({ accessToken: config.appStoreToken() });
    }, function (error, result) {
        if (error) return callback(error);
        if (result.statusCode !== 200) return callback(util.format('Failed to get build.'.red, result.statusCode, result.text));

        if (result.body.status === 'success') return callback(null, result.body);
        if (result.body.status === 'error') return callback(null, result.body);

        // if status is neither error nor success, we have to wait for the buildbot to update the status
        getBuildInfo(buildId, callback);
    });
}

function printBuildLog(buildId, callback) {
    assert(typeof buildId === 'string');
    assert(typeof callback === 'function');

    superagentEnd(function () {
        return superagent.get(createUrl('/api/v1/developers/builds/' + buildId + '/log')).query({ accessToken: config.appStoreToken() });
    }, function (error, result) {
        if (error) return callback(error);
        if (result.statusCode === 420) return callback('No build logs yet. Try again later.');
        if (result.statusCode !== 200) return callback(util.format('Failed to get build log.'.red, result.statusCode, result.text));

        var stream = result.pipe(split());

        stream.on('data', function (line) {
            if (line === '') return;
            console.log(line); // intentionally raw without json decode
        });

        stream.on('end', callback);
    });
}

function followBuildLog(buildId, raw, callback) {
    assert(typeof buildId === 'string');
    assert(typeof raw === 'boolean');

    var es = new EventSource(createUrl('/api/v1/developers/builds/' + buildId + '/logstream?accessToken=' + config.appStoreToken()));
    var prevId = null, prevWasStatus = false;

    es.on('message', function (e) {
        if (raw) return console.dir(e);

        var data = safe.JSON.parse(e.data);

        if (data.status) { // push log
            if (data.id && data.id === prevId) {
                // the code below does not work os x if the line wraps, maybe we should clip the text to window size?
                process.stdout.clearLine();
                process.stdout.cursorTo(0);
            } else if (prevWasStatus) {
                process.stdout.write('\n');
            }

            process.stdout.write(data.status + (data.id ? ' ' + data.id : '') + (data.progress ? ' ' + data.progress : ''));

            prevId = data.id;
            prevWasStatus = true;

            return;
        }

        if (prevWasStatus === true) {
            process.stdout.write('\n');
            prevId = null;
            prevWasStatus = false;
        }

        if (data.stream) { // build log
            process.stdout.write(data.stream);
        } else if (data.message) {
            console.log(data.message.yellow.bold);
        } else if (typeof data.error === 'string') {
            console.log(data.error.red.bold);
        } else if (data.error) {
            console.error(data.error);
        }
    });
    es.on('error', function (error) {
        if (raw) console.dir(error);

        if (error && error.status === 204) { // build already finished
            console.log('Building already finished. Fetching full logs'.cyan);

            return printBuildLog(buildId, callback);
        }

        // We also get { type: 'error' } messages here. Those indicate a build failure upstream
        callback(error && error.status ? error : null); // eventsource module really needs to give us better errors
    });
}

function verifyDockerfile(dockerFilePath) {
    var contents = safe.fs.readFileSync(dockerFilePath, 'utf8');
    if (!contents) return safe.error;

    var lines = contents.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var result = lines[i].match(/^\s*FROM\s+cloudron\/base:([^\s]+)\s*/i);
        if (!result) continue;

        if (!semver.valid(result[1])) return new Error('Invalid base image version');

        return null;
    }

    return new Error('Base image must be cloudron/base:0.3.1');
}

function build(options) {
    helper.verifyArguments(arguments);

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit('Error in CloudronManifest.json: ' + result.error.message.red);

    var manifest = result.manifest;

    // todo: move this to the buildbot
    var error = verifyDockerfile(path.dirname(manifestFilePath) + '/Dockerfile');
    if (error) return exit(error.message.red);

    console.log('Building %s@%s', manifest.id.bold, manifest.version.bold);
    console.log();

    var sourceArchiveFilePath = util.format('/tmp/%s.tar.gz', manifest.id);

    var stream = tar.pack(path.dirname(manifestFilePath), {
        ignore: function (name) {
            return name === (path.dirname(manifestFilePath) + '/.git'); // TODO: use minimatch and .dockerignore
        }
    }).pipe(fs.createWriteStream(sourceArchiveFilePath));

    stream.on('error', function (error) {
        exit('Failed to create application source archive: ' + error);
    });

    stream.on('finish', function () {
        superagentEnd(function () {
            return superagent.post(createUrl('/api/v1/developers/builds'))
                .query({ accessToken: config.appStoreToken(), noCache: !options.cache })
                .field('appId', manifest.id)
                .attach('sourceArchive', sourceArchiveFilePath);
        }, function (error, result) {
            if (error) return exit(util.format('Failed to build app: %s', error.message.red));
            if (result.statusCode === 413) exit('Failed to build app. The app source is too large.\n'.red);
            if (result.statusCode !== 201) exit(util.format('Failed to build app (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

            var buildId = result.body.id;

            helper.addBuild(manifest.id, buildId);

            console.log('Build scheduled with id %s', buildId.cyan);
            console.log('Waiting for build to begin, this may take a bit...');

            followBuildLog(buildId, !!options.raw, function (error) {
                if (error) return exit(error);

                getBuildInfo(buildId, function (error, build) {
                    if (error) return exit(error);

                    if (build.status === 'error') console.log('App could not be built due to errors above'.red);
                    if (build.status === 'success') console.log('Success'.green);

                    helper.updateBuild(manifest.id, buildId, build.dockerImage);

                    exit();
                });
            });
        });
    });
}

function buildLogs(options) {
    helper.verifyArguments(arguments);

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit(result.error.message);

    var manifest = result.manifest;

    helper.selectBuild(manifest.id, true /* latest */, function (error, build) {
        if (error) exit('No build found, use cloudron build to create one');

        console.log('Getting logs of %s', build.id);

        if (options.tail) return followBuildLog(build.id, exit);

        printBuildLog(build.id, exit);
    });
}

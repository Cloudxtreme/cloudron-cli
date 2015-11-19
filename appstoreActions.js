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
    cloudronActions = require('./actions.js'),
    split = require('split'),
    micromatch = require('micromatch');

require('colors');

exports = module.exports = {
    login: login,
    logout: logout,
    info: info,
    listVersions: listVersions,
    publish: publish,
    upload: upload,
    unpublish: unpublish,
    build: build,
    buildLogs: buildLogs,
    listPublishedApps: listPublishedApps
};

function createUrl(api) {
    return config.appStoreOrigin() + api;
}

// takes a function returning a superagent request instance and will reauthenticate in case the token is invalid
function superagentEnd(requestFactory, callback) {
    requestFactory().end(function (error, result) {
        if (error) return callback(error);
        if (result.statusCode === 401) return authenticate({ error: true }, superagentEnd.bind(null, requestFactory, callback));
        if (result.statusCode === 403) return callback(new Error(result.type === 'application/javascript' ? JSON.stringify(result.body) : result.text));
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

function logout() {
    config.unset('appStoreToken');
    console.log('Done.'.green);
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

function parseChangelog(file, version) {
    var changelog = '';
    var data = safe.fs.readFileSync(file, 'utf8');
    if (!data) return null;
    var lines = data.split('\n');

    for (var i = 0; i < lines.length; i++) {
        if (lines[i] === '[' + version + ']') break;
    }

    for (i = i + 1; i < lines.length; i++) {
        if (lines[i] === '') continue;
        if (lines[i][0] === '[') break;

        changelog += lines[i];
    }

    return changelog;
}

function addVersion(manifest, buildId, baseDir, callback) {
    assert(typeof manifest === 'object');
    assert(typeof buildId === 'string');
    assert(typeof baseDir === 'string');

    var iconFilePath = null;
    if (manifest.icon) {
        var iconFile = manifest.icon; // backward compat
        if (iconFile.slice(0, 7) === 'file://') iconFile = iconFile.slice(7);

        iconFilePath = path.isAbsolute(iconFile) ? iconFile : path.join(baseDir, iconFile);
        if (!fs.existsSync(iconFilePath)) return callback(new Error('icon not found at ' + iconFilePath));
    }

    if (manifest.description.slice(0, 7) === 'file://') {
        var descriptionFilePath = manifest.description.slice(7);
        manifest.description = safe.fs.readFileSync(descriptionFilePath, 'utf8');
        if (!manifest.description) return callback(new Error('Could not read/parse description ' + safe.error.message));
    }

    if (manifest.changelog.slice(0, 7) === 'file://') {
        var changelogPath = manifest.changelog.slice(7);
        manifest.changelog = parseChangelog(changelogPath, manifest.version);
        if (!manifest.changelog) return callback(new Error('Bad changelog format or missing changelog for this version'));
    }

    superagentEnd(function () {
        var req = superagent.post(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions'));
        req.query({ accessToken: config.appStoreToken() });
        if (iconFilePath) req.attach('icon', iconFilePath);
        req.field('buildId', buildId);
        req.attach('manifest', new Buffer(JSON.stringify(manifest)), { filename: 'manifest' });
        return req;
    }, function (error, result) {
        if (error) return callback(new Error(util.format('Failed to publish version: %s', error.message)));
        if (result.statusCode !== 204)
            callback(new Error(util.format('Failed to publish version (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text)));

        callback();
    });
}

function updateVersion(manifest, buildId, baseDir, callback) {
    assert(typeof manifest === 'object');
    assert(typeof buildId === 'string');
    assert(typeof baseDir === 'string');

    var iconFilePath = null;
    if (manifest.icon) {
        var iconFile = manifest.icon; // backward compat
        if (iconFile.slice(0, 7) === 'file://') iconFile = iconFile.slice(7);

        iconFilePath = path.isAbsolute(iconFile) ? iconFile : path.join(baseDir, iconFile);
        if (!fs.existsSync(iconFilePath)) return callback(new Error('icon not found at ' + iconFilePath));
    }

    if (manifest.description.slice(0, 7) === 'file://') {
        var descriptionFilePath = manifest.description.slice(7);
        manifest.description = safe.fs.readFileSync(descriptionFilePath, 'utf8');
        if (!manifest.description) return callback(new Error('Could not read description ' + safe.error.message));
    }

    if (manifest.changelog.slice(0, 7) === 'file://') {
        var changelogPath = manifest.changelog.slice(7);
        manifest.changelog = parseChangelog(changelogPath, manifest.version);
        if (!manifest.changelog) return callback(new Error('Could not read changelog ' + safe.error.message));
    }

    superagentEnd(function () {
        var req = superagent.put(createUrl('/api/v1/developers/apps/' + manifest.id + '/versions/' + manifest.version));
        req.query({ accessToken: config.appStoreToken() });
        if (iconFilePath) req.attach('icon', iconFilePath);
        req.field('buildId', buildId);
        req.attach('manifest', new Buffer(JSON.stringify(manifest)), { filename: 'manifest' });
        return req;
    }, function (error, result) {
        if (error) return callback(new Error(util.format('Failed to publish version: %s', error.message)));
        if (result.statusCode !== 204) {
            return callback(new Error(util.format('Failed to publish version (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text)));
        }

        callback();
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

        console.log('App submitted for review.'.green);
        console.log('You will receive an email when approved.');

        callback();
    });
}

function upload(options) {
    helper.verifyArguments(arguments);

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit(result.error.message);

    var error = manifestFormat.checkAppstoreRequirements(result.manifest);
    if (error) return exit(error.message);

    var manifest = result.manifest;

    // ensure the app is known on the appstore side
    addApp(manifest, path.dirname(manifestFilePath), function () {
        helper.selectBuild(manifest.id, true /* latest */, function (error, build) {
            if (error || !build.dockerImage) exit('No build found, please run `cloudron build` first and test the new build on your Cloudron.');

            console.log('Publishing %s@%s for %s with build %s.', manifest.id, manifest.version, 'testing'.yellow, build.id);

            var func = options.force ? updateVersion : addVersion;

            func(manifest, build.id, path.dirname(manifestFilePath), function (error) {
                if (error) return exit(error);

                console.log('\nThe App Store view\'s %s tab in your cloudron will show the app.', 'testing'.yellow);

                console.log('\nApp can be tested on other cloudrons using the cli tool:\n\t\t%s', ('cloudron install --appstore-id ' + manifest.id + '@' + manifest.version).white);

                if (config.cloudron()) {
                    var url = cloudronActions.createUrl('/#/appstore/' + manifest.id + '?version=' + manifest.version);
                    console.log('\nDirect link to the app on your Cloudron:\n\t\t%s\n', url.white);
                }
            });
        });
    });
}

function publish() {
    helper.verifyArguments(arguments);

    // try to find the manifest of this project
    var manifestFilePath = helper.locateManifest();
    if (!manifestFilePath) return exit('No CloudronManifest.json found');

    var result = manifestFormat.parseFile(manifestFilePath);
    if (result.error) return exit(result.error.message);

    var error = manifestFormat.checkAppstoreRequirements(result.manifest);
    if (error) return exit(error.message);

    var manifest = result.manifest;

    submitAppForReview(manifest, exit);
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

        stream.on('end', function () {
            console.log();
            callback();
        });
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
            console.log();

            return printBuildLog(buildId, callback);
        }

        // We sometimes get { type: 'error' } from es module when the server closes the socket. not clear why
        if (error && !error.status && error.type === 'error') error = null;

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

    return new Error('Base image must be cloudron/base:0.5.0');
}

function dockerignoreMatcher(dockerignorePath) {
    var patterns = [ ];

    if (fs.existsSync(dockerignorePath)) {
        var lines = fs.readFileSync(dockerignorePath, 'utf8').split('\n');

        patterns = lines.filter(function (line) { return line.trim().length !== 0 && line[0] !== '#'; });
    }

    return function ignore(path) {
        return micromatch([ path ], patterns, { dot: true }).length == 1;
    };
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

    var sourceDir = path.dirname(manifestFilePath);
    var sourceArchiveFilePath = util.format('/tmp/%s.tar.gz', manifest.id);
    var dockerignoreFilePath = path.join(sourceDir, '.dockerignore');
    var ignoreMatcher = dockerignoreMatcher(dockerignoreFilePath);

    var stream = tar.pack(path.dirname(manifestFilePath), {
        ignore: function (name) {
            return ignoreMatcher(name.slice(sourceDir.length + 1)); // make name as relative path
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

                    if (build.status === 'success') {
                        helper.updateBuild(manifest.id, buildId, build.dockerImage);
                        console.log('Success'.green);
                        exit();
                    } else if (build.status === 'error') {
                        exit('App could not be built due to errors above');
                    } else {
                        exit('Build has unknown status ' + build.status);
                    }
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

// TODO currently no pagination, only needed once we have users with more than 100 apps
function listPublishedApps() {
    helper.verifyArguments(arguments);

    superagentEnd(function () {
        return superagent.get(createUrl('/api/v1/developers/apps?per_page=100'))
        .query({ accessToken: config.appStoreToken() })
        .send({ });
    }, function (error, result) {
        if (error) return exit(util.format('Failed to get list of published apps: %s', error.message.red));
        if (result.statusCode !== 200) return exit(util.format('Failed to get list of published apps (statusCode %s): \n%s', result.statusCode, result.body && result.body.message ? result.body.message.red : result.text));

        if (result.body.apps.length === 0) return console.log('No apps published.');

        var t = new Table();

        result.body.apps.forEach(function (app) {
            t.cell('Id', app.id);
            t.cell('Title', app.manifest.title);
            t.cell('Latest Version', app.manifest.version);
            t.cell('Publish State', app.publishState);
            t.cell('Creation Date', new Date(app.creationDate));
            t.newRow();
        });

        console.log();
        console.log(t.toString());
    });
}

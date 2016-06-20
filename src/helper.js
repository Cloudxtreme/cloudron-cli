/* jshint node:true */

'use strict';

var assert = require('assert'),
    config = require('./config.js'),
    fs = require('fs'),
    path = require('path'),
    readlineSync = require('readline-sync'),
    safe = require('safetydance'),
    spawn = require('child_process').spawn,
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    exit: exit,
    missing: missing,

    locateManifest: locateManifest,
    getAppStoreId: getAppStoreId,
    verifyArguments: verifyArguments,

    addBuild: addBuild,
    updateBuild: updateBuild,
    selectImage: selectImage,
    selectBuild: selectBuild,
    selectUserSync: selectUserSync,

    showDeveloperModeNotice: showDeveloperModeNotice,
    detectCloudronApiEndpoint: detectCloudronApiEndpoint,

    exec: exec,
    getSSH: getSSH
};

function exit(error) {
    if (error instanceof Error) console.log(error.message.red);
    else if (error) console.error(util.format.apply(null, Array.prototype.slice.call(arguments)).red);

    process.exit(error ? 1 : 0);
}

function missing(argument) {
    exit('You must specify --' + argument);
}

function locateManifest() {
    var curdir = process.cwd();
    do {
        var candidate = path.join(curdir, 'CloudronManifest.json');
        if (fs.existsSync(candidate)) return candidate;

        if (curdir === '/') break;

        curdir = path.resolve(curdir, '..');
    } while (true);

    return null;
}

// the app argument allows us in the future to get by name or id
function getAppStoreId(appId, callback) {
    if (appId) return callback(null, appId);

    var manifestFilePath = locateManifest();

    if (!manifestFilePath) return callback('No CloudronManifest.json found');

    var manifest = safe.JSON.parse(safe.fs.readFileSync(manifestFilePath));
    if (!manifest) callback(util.format('Unable to read manifest %s. Error: %s', manifestFilePath, safe.error));

    return callback(null, manifest.id);
}

function verifyArguments(args) {
    if (args.length > 1) {
        console.log('Too many arguments');
        args[args.length-1].parent.help();
        process.exit(1);
    }
}

function prettyDate(time) {
    var date = new Date(time),
        diff = (((new Date()).getTime() - date.getTime()) / 1000),
        day_diff = Math.floor(diff / 86400);

    if (isNaN(day_diff) || day_diff < 0 || day_diff >= 31)
        return;

    return day_diff == 0 && (
            diff < 60 && 'just now' ||
            diff < 120 && '1 minute ago' ||
            diff < 3600 && Math.floor( diff / 60 ) + ' minutes ago' ||
            diff < 7200 && '1 hour ago' ||
            diff < 86400 && Math.floor( diff / 3600 ) + ' hours ago') ||
        day_diff == 1 && 'Yesterday' ||
        day_diff < 7 && day_diff + ' days ago' ||
        day_diff < 31 && Math.ceil( day_diff / 7 ) + ' weeks ago';
}

function addBuild(appId, buildId) {
    var builds = config.get('apps.' + appId) || [ ];
    builds.push({ id: buildId, ts: new Date().toISOString() });
    config.set('apps.' + appId, builds);
}

function updateBuild(appId, buildId, dockerImage) {
    var builds = config.get('apps.' + appId);
    builds.forEach(function (build) { if (build.id === buildId) build.dockerImage = dockerImage; });
    config.set('apps.' + appId, builds);
}

function selectImage(manifest, latest, callback) {
    assert(typeof manifest === 'object');
    assert(typeof latest === 'boolean');
    assert(typeof callback === 'function');

    if (manifest.dockerImage) return callback(null, manifest.dockerImage);

    selectBuild(manifest.id, latest, function (error, build) {
        if (error) return callback(error);
        return callback(null, build.dockerImage);
    });
}

function selectBuild(appId, latest, callback) {
    assert(typeof appId === 'string');
    assert(typeof latest === 'boolean');
    assert(typeof callback === 'function');

    var builds = config.get('apps.' + appId) || [ ];

    if (builds.length === 0) return callback(new Error('No build found'));

    // builds are sorted by time already
    if (builds.length === 1 || latest) {
        var build = builds[builds.length - 1];
        return callback(null, build);
    }

    console.log();
    console.log('Available builds:');
    builds.forEach(function (build, index) {
        console.log('[%s]\t%s - %s', index, build.id.cyan, prettyDate(build.ts).bold);
    });

    var index = -1;
    while (true) {
        index = parseInt(readlineSync.question('Choose build [0-' + (builds.length-1) + ']: ', {}));
        if (isNaN(index) || index < 0 || index > builds.length-1) console.log('Invalid selection'.red);
        else break;
    }

    console.log();

    callback(null, builds[index]);
}

function selectUserSync(users) {
    assert(typeof users === 'object');

    if (users.length === 1) return users[0];

    console.log();
    console.log('Available users:');
    users.forEach(function (user, index) {
        console.log('[%s]\t%s - %s', index, (user.username || '(unset)').cyan, user.email);
    });

    var index = -1;
    while (true) {
        index = parseInt(readlineSync.question('Choose user [0-' + (users.length-1) + ']: ', {}));
        if (isNaN(index) || index < 0 || index > users.length-1) console.log('Invalid selection'.red);
        else break;
    }

    console.log();

    return users[index];
}

function showDeveloperModeNotice(endpoint) {
    assert(typeof endpoint === 'string');

    console.error('CLI mode is disabled. Enable it at %s.'.red, 'https://' + endpoint + '/#/settings');
}

function detectCloudronApiEndpoint(cloudron, callback) {
    assert(typeof cloudron === 'string');
    assert(typeof callback === 'function');

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

// do not pipe fds. otherwise, the shell does not detect input as a tty and does not change the terminal window size
// https://groups.google.com/forum/#!topic/nodejs/vxIwmRdhrWE
function exec(command, args, callback) {
    var options = { stdio: 'inherit' }; // pipe output to console
    var child = spawn(command, args, options);

    callback = callback || function () { };

    child.on('error', callback);
    child.on('close', function (code) { callback(code === 0 ? null : new Error(util.format('%s exited with code %d', command, code))); });
}

function getSSH(host, sshKey, cmd) {
    cmd = cmd || '';
    cmd = Array.isArray(cmd) ? cmd.join(' ') : cmd;

    var SSH = 'root@%s -tt -p 202 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i %s %s';

    return util.format(SSH, host, sshKey, cmd).split(' ');
}
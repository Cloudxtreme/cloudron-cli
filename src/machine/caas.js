'use strict';

var assert = require('assert'),
    config = require('../config.js'),
    readlineSync = require('readline-sync'),
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    create: create,
    restore: restore,
    migrate: migrate,
    getBackupListing: getBackupListing
};

function createUrl(api) {
    assert.strictEqual(typeof api, 'string');

    return config.appStoreOrigin() + api;
}

function waitForCloudronReady(cloudron, callback) {
    assert.strictEqual(typeof config.appStoreToken(), 'string');
    assert.strictEqual(typeof cloudron, 'object');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for Cloudron to come to life...');

    (function checkStatus() {
        process.stdout.write('.');

        superagent.get(createUrl('/api/v1/cloudrons/' + cloudron.id)).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
            if (error && !error.response) return setTimeout(checkStatus, 2000);
            if (result.statusCode !== 200) return callback(new Error('Failed to get Cloudron status. ' + result.statusCode + ' - ' + (result.body ? result.body.message : result.text)));
            if (result.body.box.status !== 'ready') return setTimeout(checkStatus, 2000);

            callback();
        });
    })();
}

function getCloudronByFQDN(fqdn, callback) {
    assert.strictEqual(typeof config.appStoreToken(), 'string');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    superagent.get(createUrl('/api/v1/cloudrons')).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
        if (error && !error.response) return callback(new Error(util.format('Failed to list cloudrons: %s', error.message)));
        if (result.statusCode !== 200) return callback(new Error(util.format('Failed to list cloudrons: %s message: %s', result.statusCode, result.text)));

        var cloudron = result.body.boxes.filter(function (b) { return b.domain === fqdn; })[0];
        if (!cloudron) return callback(new Error('No such Cloudron ' + fqdn));

        callback(null, cloudron);
    });
}

function create(options, version, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(function (error) {
        if (error) return callback(error);

        console.log('Create Cloudron...');

        superagent.post(createUrl('/api/v1/cloudrons')).query({ accessToken: config.appStoreToken() }).send({
            domain: options.fqdn,
            region: options.region,
            size: options.type,
            version: version
        }).end(function (error, result) {
            if (error && !error.response) return callback(error);
            if (result.statusCode !== 201) return callback(new Error('Failed to create Cloudron: ' + (result.body ? result.body.message : result.text)));

            waitForCloudronReady(result.body.box, callback);
        });
    });
}

function restore(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(function (error) {
        if (error) return callback(error);

        getCloudronByFQDN(options.fqdn, function (error, cloudron) {
            if (error) return callback(error);

            console.log('Restore Cloudron...');

            superagent.post(createUrl(util.format('/api/v1/cloudrons/%s/restore/%s', cloudron.id, backup.id))).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
                if (error && !error.response)return callback(error);
                if (result.statusCode !== 202) return callback(new Error(util.format('Failed to restore cloudron: %s message: %s', result.statusCode, result.text)));

                waitForCloudronReady(cloudron, callback);
            });
        });
    });
}

function migrate(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.fqdnFrom, 'string');
    assert.strictEqual(typeof options.fqdnTo, 'string');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(function (error) {
        if (error) return callback(error);

        getCloudronByFQDN(options.fqdnFrom, function (error, cloudron) {
            if (error) return callback(error);

            console.log('Migrate Cloudron...');

            superagent.post(createUrl(util.format('/api/v1/admin/%s/migrate', cloudron.id))).send({
                domain: options.fqdnTo,
                size: options.type,
                region: options.region,
                restoreKey: backup.id
            }).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
                if (error && !error.response) return callback(error);
                if (result.statusCode !== 202) return callback(new Error(util.format('Failed to migrate cloudron: %s message: %s', result.statusCode, result.text)));

                waitForCloudronReady(cloudron, callback);
            });
        });
    });
}

function loginAppstore(callback) {
    assert.strictEqual(typeof callback, 'function');

    function relogin() {
        console.log();
        console.log('Enter ' + 'appstore'.cyan.bold + ' credentials:');

        var username = readlineSync.question('Username: ', {});
        var password = readlineSync.question('Password: ', { noEchoBack: true });

        superagent.get(createUrl('/api/v1/login')).auth(username, password).end(function (error, result) {
            if (error && !error.response) return callback(error);
            if (result.statusCode !== 200) {
                console.log('Login failed.'.red);
                return relogin();
            }

            console.log('Login successful.'.green);

            config.set('appStoreToken', result.body.accessToken);

            callback(null);
        });
    }

    // skip if we already have a token
    if (config.appStoreToken()) {
        // verify the token
        superagent.get(createUrl('/api/v1/profile')).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
            if (error && !error.response) return callback(error);
            if (result.statusCode !== 200) return relogin();

            callback(null);
        });
    } else {
        relogin();
    }
}

function getBackupListing(fqdn, options, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(function (error) {
        if (error) return callback(error);

        getCloudronByFQDN(fqdn, function (error, cloudron) {
            if (error) return callback(error);

            superagent.get(createUrl(util.format('/api/v1/cloudrons/%s/backups', cloudron.id))).query({ accessToken: config.appStoreToken() }).end(function (error, result) {
                if (error && !error.response) return callback(error);
                if (result.statusCode !== 200) return callback(new Error(util.format('Failed to get backups: %s message: %s', result.statusCode, result.text)));

                // Keep the objects in sync
                result.body.backups.forEach(function (backup) { backup.id = backup.restoreKey; });

                callback(null, result.body.backups);
            });
        });
    });
}

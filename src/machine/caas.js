'use strict';

var assert = require('assert'),
    readlineSync = require('readline-sync'),
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    create: create,
    restore: restore
};

var APPSTORE_API_ENDPOINT = 'api.dev.cloudron.io';

var gToken = null;

function createUrl(api) {
    assert.strictEqual(typeof api, 'string');

    return 'https://' + APPSTORE_API_ENDPOINT + api;
}

function waitForCloudronReady(cloudron, callback) {
    assert.strictEqual(typeof cloudron, 'object');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for Cloudron to come to life...');

    (function checkStatus() {
        process.stdout.write('.');

        superagent.get(createUrl('/api/v1/cloudrons/' + cloudron.id)).query({ accessToken: gToken }).end(function (error, result) {
            if (error) return setTimeout(checkStatus, 2000);
            if (result.statusCode !== 200) return callback(new Error('Failed to get Cloudron status. ' + result.statusCode + ' - ' + (result.body ? result.body.message : result.text)));
            if (result.body.box.status !== 'ready') return setTimeout(checkStatus, 2000);

            callback();
        });
    })();
}

function getCloudronByFQDN(fqdn, callback) {
    assert.strictEqual(typeof gToken, 'string');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    superagent.get(createUrl('/api/v1/cloudrons')).query({ accessToken: gToken }).end(function (error, result) {
        if (error) return callback(new Error(util.format('Failed to list cloudrons: %s', error.message)));
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

    loginAppstore(options, function (error) {
        if (error) return callback(error);

        console.log('Create Cloudron...');

        superagent.post(createUrl('/api/v1/cloudrons')).query({ accessToken: gToken }).send({
            domain: options.fqdn,
            region: options.region,
            size: options.type,
            version: version
        }).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 201) return callback(new Error('Failed to create Cloudron: ' + (result.body ? result.body.message : result.text)));

            waitForCloudronReady(result.body.box, callback);
        });
    });
}

function restore(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(options, function (error) {
        if (error) return callback(error);

        getCloudronByFQDN(options.fqdn, function (error, cloudron) {
            if (error) return callback(error);

            console.log('Restore Cloudron...');

            superagent.post(createUrl(util.format('/api/v1/cloudrons/%s/restore/%s', cloudron.id, backup.id))).query({ accessToken: gToken }).end(function (error, result) {
                if (error) return callback(error);
                if (result.statusCode !== 202) return callback(new Error(util.format('Failed to restore cloudron: %s message: %s', result.statusCode, result.text)));

                waitForCloudronReady(cloudron, callback);
            });
        });
    });
}

function loginAppstore(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    console.log();
    console.log('Enter ' + 'appstore'.cyan.bold + ' credentials:');

    var username = readlineSync.question('Username: ', {});
    var password = readlineSync.question('Password: ', { noEchoBack: true });

    superagent.get(createUrl('/api/v1/login')).auth(username, password).end(function (error, result) {
        if (error) return callback(error);
        if (result.statusCode !== 200) {
            console.log('Login failed.'.red);
            return loginAppstore(options, callback);
        }

        console.log('Login successful.'.green);

        gToken = result.body.accessToken;

        callback(null, result.body.accessToken);
    });
}

'use strict';

var assert = require('assert'),
    readlineSync = require('readline-sync'),
    superagent = require('superagent');

exports = module.exports = {
    create: create
};

var APPSTORE_API_ENDPOINT = 'api.dev.cloudron.io';

function createAppstoreUrl(api) {
    assert.strictEqual(typeof api, 'string');

    return 'https://' + APPSTORE_API_ENDPOINT + api;
}

function create(options, version, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    loginAppstore(options, function (error, token) {
        if (error) return callback(error);

        superagent.post(createAppstoreUrl('/api/v1/cloudrons')).query({ accessToken: token }).send({
            domain: options.fqdn,
            region: options.region,
            size: options.type,
            version: version
        }).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 201) return callback(new Error('Failed to create Cloudron: ' + (result.body ? result.body.message : result.text)));

            var id = result.body.box.id;

            process.stdout.write('Waiting for Cloudron to come to life...');

            (function checkStatus() {
                process.stdout.write('.');

                superagent.get(createAppstoreUrl('/api/v1/cloudrons/' + id)).query({ accessToken: token }).end(function (error, result) {
                    if (error) return setTimeout(checkStatus, 2000);
                    if (result.statusCode !== 200) return callback(new Error('Failed to get Cloudron status. ' + result.statusCode + ' - ' + (result.body ? result.body.message : result.text)));
                    if (result.body.status !== 'ready') return setTimeout(checkStatus, 2000);

                    callback();
                });
            })();
        });
    });
}

function loginAppstore(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    console.log();

    if (!options.username || !options.password) console.log('Enter appstore credentials:');

    var username = options.username || readlineSync.question('Username: ', {});
    var password = options.password || readlineSync.question('Password: ', { noEchoBack: true });

    superagent.get(createAppstoreUrl('/api/v1/login')).auth(username, password).end(function (error, result) {
        if (error) return callback(error);
        if (result.statusCode !== 200) {
            console.log('Login failed.'.red);
            return loginAppstore(options, callback);
        }

        console.log('Login successful.'.green);

        callback(null, result.body.accessToken);
    });
}

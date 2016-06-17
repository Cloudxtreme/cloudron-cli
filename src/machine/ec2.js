'use strict';

var assert = require('assert'),
    aws = require('./aws.js'),
    helper = require('../helper.js'),
    tasks = require('./tasks.js');

exports = module.exports = {
    create: create,
    getBackupListing: getBackupListing
};

function getBackupListing(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!options.region) helper.missing('region');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupBucket) helper.missing('backup-bucket');

    aws.init({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    aws.listBackups(options.backupBucket, cloudron, function (error, result) {
        if (error) return callback(error);

        callback(null, result);
    });
}

function create(options, version, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupKey) helper.missing('backup-key');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');
    if (!options.subnet) helper.missing('subnet');
    if (!options.securityGroup) helper.missing('security-group');

    var params = {
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        backupKey: options.backupKey,
        backupBucket: options.backupBucket,
        version: version,
        type: options.type,
        sshKey: options.sshKey,
        domain: options.fqdn,
        subnet: options.subnet,
        securityGroup: options.securityGroup
    };

    tasks.create(params, function (error) {
        if (error) return callback(error);
        callback();
    });
}

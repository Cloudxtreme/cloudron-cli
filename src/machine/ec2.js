'use strict';

var assert = require('assert'),
    aws = require('./aws.js'),
    helper = require('../helper.js'),
    ec2tasks = require('./ec2tasks.js');

exports = module.exports = {
    create: create,
    restore: restore,
    upgrade: upgrade,
    migrate: migrate,
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
    if (!options.size) helper.missing('size');
    if (!options.backupKey) helper.missing('backup-key');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');

    if (options.size < 40) helper.exit('--size must be at least 40');

    if (!options.subnet ^ !options.securityGroup) return helper.exit('either both --subnet and --security-group must be provided OR none');

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
        securityGroup: options.securityGroup,
        size: options.size
    };

    ec2tasks.create(params, callback);
}

function restore(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!options.type) helper.missing('type');
    if (!options.region) helper.missing('region');
    if (!options.size) helper.missing('size');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupKey) helper.missing('backup-key');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');

    if (options.size < 40) helper.exit('--size must be at least 40');

    if (!options.subnet ^ !options.securityGroup) return helper.exit('either both --subnet and --security-group must be provided OR none');

    var params = {
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        backupBucket: options.backupBucket,
        backupKey: options.backupKey,
        backup: backup,
        type: options.type,
        size: options.size,
        sshKey: options.sshKey,
        domain: options.fqdn,
        subnet: options.subnet,
        securityGroup: options.securityGroup
    };

    ec2tasks.restore(params, callback);
}

function upgrade(updateInfo, options, callback) {
    assert.strictEqual(typeof updateInfo, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        version: updateInfo.version,
        domain: options.domain,
        sshKeyFile: options.sshKeyFile
    };

    ec2tasks.upgrade(params, callback);
}

function migrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (options.region) helper.exit('Moving to another EC2 region is not yet supported');

    if (!options.sshKeyFile) helper.missing('ssh-key-file');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');

    if (options.size < 40) helper.exit('--size must be at least 40');

    var params = {
        fqdn: options.fqdn,
        sshKeyFile: options.sshKeyFile,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        newFqdn: options.newFqdn || null,
        type: options.type || null,
        size: options.size || null
    };

    ec2tasks.migrate(params, callback);
}

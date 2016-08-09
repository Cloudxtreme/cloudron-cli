'use strict';

var assert = require('assert'),
    aws = require('./aws.js'),
    hat = require('hat'),
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
    if (!options.diskSize) helper.missing('disk-size');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');

    if (options.diskSize < 30) helper.exit('--disk-size must be at least 30');

    if (!options.subnet ^ !options.securityGroup) return helper.exit('either both --subnet and --security-group must be provided OR none');

    if (!options.backupKey) {
        console.log();
        console.log('No backup key specified.');
        options.backupKey = hat(256);
        console.log('Generated backup key: ', options.backupKey.bold.cyan);
        console.log('Remember to keep the backup key in a safe location. You will need it to restore your Cloudron!'.yellow);
        console.log();
    }

    var params = {
        region: options.awsRegion || options.region,
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
        size: options.diskSize
    };

    ec2tasks.create(params, callback);
}

function restore(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!options.type) helper.missing('type');
    if (!options.region) helper.missing('region');
    if (!options.diskSize) helper.missing('disk-size');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupKey) helper.missing('backup-key');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');

    if (options.diskSize < 30) helper.exit('--disk-size must be at least 30');

    if (!options.subnet ^ !options.securityGroup) return helper.exit('either both --subnet and --security-group must be provided OR none');

    var params = {
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        backupBucket: options.backupBucket,
        backupKey: options.backupKey,
        backup: backup,
        type: options.type,
        size: options.diskSize,
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

    if (!options.sshKey) helper.missing('ssh-key');

    options.sshKey = helper.findSSHKey(options.sshKey);
    if (!options.sshKey) helper.exit('Unable to find SSH key');

    var params = {
        version: updateInfo.version,
        domain: options.domain,
        sshKey: options.sshKey
    };

    ec2tasks.upgrade(params, callback);
}

function migrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (options.region) helper.exit('Moving to another EC2 region is not yet supported');

    if (!options.sshKey) helper.missing('ssh-key');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');

    if (options.diskSize && options.diskSize < 30) helper.exit('--disk-size must be at least 30');

    options.sshKey = helper.findSSHKey(options.sshKey);
    if (!options.sshKey) helper.exit('Unable to find SSH key');

    var params = {
        fqdn: options.fqdn,
        sshKeyFile: options.sshKey,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        newFqdn: options.newFqdn || null,
        type: options.type || null,
        size: options.diskSize || null
    };

    ec2tasks.migrate(params, callback);
}

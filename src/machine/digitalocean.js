'use strict';

var assert = require('assert'),
    async = require('async'),
    aws = require('./aws.js'),
    hat = require('hat'),
    helper = require('../helper.js'),
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    create: create,
    restore: restore,
    upgrade: upgrade,
    migrate: migrate,
    getBackupListing: getBackupListing
};

function checkDNSZone(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    console.log('Checking DNS zone...');

    aws.checkIfDNSZoneExists(params.domain, function (error) {
        if (error) return callback(error);

        callback();
    });
}

function checkS3BucketAccess(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.backupBucket, 'string');
    assert.strictEqual(typeof callback, 'function');

    console.log('Checking S3 bucket access...');

    aws.checkS3BucketAccess(params.backupBucket, function (error) {
        if (error) return callback(error);

        callback();
    });
}

function createServer(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof params.region, 'string');
    assert.strictEqual(typeof params.type, 'string');
    assert.strictEqual(typeof params.sshKey, 'string');
    assert.strictEqual(typeof params.token, 'string');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Creating server...');

    var data = {
        name: params.domain,
        region: params.region,
        size: params.type,
        image: 'ubuntu-16-04-x64',
        ssh_keys: [ params.sshKey ],
        backups: false,

    };

    superagent.post('https://api.digitalocean.com/v2/droplets').send(data).set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
        if (error) return callback(error.message);
        if (result.statusCode !== 202) return callback(util.format('Droplet creation failed. %s %j', result.statusCode, result.body));

        params.instanceId = result.body.droplet.id;
        params.createAction = result.body.links.actions[0];

        console.log(params.instanceId);

        callback();
    });
}

function waitForServer(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.token, 'string');
    assert.strictEqual(typeof params.createAction, 'object');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for server to come up...');

    async.forever(function (callback) {
        superagent.get(params.createAction.href).set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
            if (error) return callback();
            if (result.statusCode !== 200) return callback(util.format('Waiting for droplet failed. %s %j', result.statusCode, result.body));

            if (result.body.action.status !== 'completed') {
                process.stdout.write('.');
                setTimeout(callback, 5000);
                return;
            }

            callback('done');
        });
    }, function (errorOrDone) {
        if (errorOrDone !== 'done') return callback(errorOrDone);

        process.stdout.write('\n');

        callback();
    });
}

function getIp(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.token, 'string');
    assert.strictEqual(typeof params.instanceId, 'string');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Getting public IP...');

    superagent.get('https://api.digitalocean.com/v2/droplets/' + params.instanceId).set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
        if (error) return callback(error.message);
        if (result.statusCode !== 200) return callback(util.format('Droplet details failed. %s %j', result.statusCode, result.body));

        params.publicIP = result.body.droplet.networks.v4.ip_address;

        console.log(params.publicIP);

        callback();
    });
}

function getBackupListing(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!options.region) helper.missing('region');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupBucket) helper.missing('backup-bucket');

    callback('not implemented');
}

function create(options, version, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.diskSize) helper.missing('disk-size');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.token) helper.missing('token');
    if (!options.sshKey) helper.missing('ssh-key');

    if (!options.backupKey) {
        console.log();
        console.log('No backup key specified.');
        options.backupKey = hat(256);
        console.log('Generated backup key: ', options.backupKey.bold.cyan);
        console.log('Remember to keep the backup key in a safe location. You will need it to restore your Cloudron!'.yellow);
        console.log();
    }

    var params = {
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        backupKey: options.backupKey,
        backupBucket: options.backupBucket,
        version: version,
        type: options.type,
        sshKey: options.sshKey,
        domain: options.fqdn
    };

    console.log('Using version %s', options.version.cyan.bold);

    aws.init({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    var tasks = [
        checkDNSZone.bind(null, params),
        checkS3BucketAccess.bind(null, params),
        createServer.bind(null, params),
        waitForServer.bind(null, params),
        getIp.bind(null, params),
        // waitForDNS.bind(null, params),
        // waitForStatus.bind(null, params)
    ];

    async.series(tasks, function (error) {
        if (error) return callback(error);

        console.log('');
        console.log('Cloudron created with:');
        console.log('  ID:        %s', params.instanceId.cyan);
        console.log('  Public IP: %s', params.publicIP.cyan);
        console.log('');

        callback();
    });
}

function restore(options, backup, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!options.type) helper.missing('type');
    if (!options.region) helper.missing('region');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');
    if (!options.backupKey) helper.missing('backup-key');
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.sshKey) helper.missing('ssh-key');

    var params = {
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        backupBucket: options.backupBucket,
        backupKey: options.backupKey,
        backup: backup,
        type: options.type,
        sshKey: options.sshKey,
        domain: options.fqdn,
        subnet: options.subnet,
        securityGroup: options.securityGroup
    };

    callback('not implemented');
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

    callback('not implemented');
}

function migrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (options.region) helper.exit('Moving to another EC2 region is not yet supported');

    if (!options.sshKey) helper.missing('ssh-key');
    if (!options.accessKeyId) helper.missing('access-key-id');
    if (!options.secretAccessKey) helper.missing('secret-access-key');

    options.sshKey = helper.findSSHKey(options.sshKey);
    if (!options.sshKey) helper.exit('Unable to find SSH key');

    var params = {
        fqdn: options.fqdn,
        sshKeyFile: options.sshKey,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        newFqdn: options.newFqdn || null,
        type: options.type || null
    };

    callback('not implemented');
}

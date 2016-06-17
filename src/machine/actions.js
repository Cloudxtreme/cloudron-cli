'use strict';

var assert = require('assert'),
    aws = require('./aws.js'),
    helper = require('../helper.js'),
    readlineSync = require('readline-sync'),
    superagent = require('superagent'),
    Table = require('easy-table'),
    tasks = require('./tasks.js'),
    util = require('util'),
    versions = require('./versions.js');

exports = module.exports = {
    create: create,
    restore: restore,
    listBackups: listBackups,
    createBackup: createBackup,
    login: helper.login
};

var APPSTORE_API_ENDPOINT = 'api.dev.cloudron.io';

var gCloudronApiEndpoint = null;

function createUrl(api) {
    assert.strictEqual(typeof gCloudronApiEndpoint, 'string');
    assert.strictEqual(typeof api, 'string');

    return 'https://' + gCloudronApiEndpoint + api;
}

function createAppstoreUrl(api) {
    assert.strictEqual(typeof api, 'string');

    return 'https://' + APPSTORE_API_ENDPOINT + api;
}

function getBackupListingFromS3(cloudron, options, callback) {
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

function getBackupListing(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (options.fallback) {
        console.log('Falling back to s3 bucket listing');
        return getBackupListingFromS3(cloudron, options, callback);
    }

    // FIXME get from S3 or caas as a fallback
    login(cloudron, options, function (error, token) {
        if (error) {
            console.log(error);
            console.log('Falling back to s3 bucket listing');
            return getBackupListingFromS3(cloudron, options, callback);
        }

        superagent.get(createUrl('/api/v1/backups')).query({ access_token: token }).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(util.format('Failed to list backups.'.red, result.statusCode, result.text));

            callback(null, result.body.backups);
        });
    });
}

function createEC2(options, version, callback) {
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

function createCaas(options, version, callback) {
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

            console.log(result.statusCode, result.body);

            callback(null, result.body);
        });
    });
}

function create(options) {
    assert.strictEqual(typeof options, 'object');

    var provider = options.provider;
    var region = options.region;
    var release = options.release;
    var type = options.type;
    var fqdn = options.fqdn;

    // shared arguments
    if (!provider) helper.missing('provider');
    if (!release) helper.missing('release');
    if (!fqdn) helper.missing('fqdn');
    if (!type) helper.missing('type');
    if (!region) helper.missing('region');

    versions.resolve(options.release, function (error, result) {
        if (error) helper.exit(error);

        var func;
        if (options.provider === 'ec2') func = createEC2;
        else if (options.provider === 'caas') func = createCaas;
        else helper.exit('--provider must be either "caas" or "ec2"');

        func(options, result, function (error) {
            if (error) helper.exit(error);

            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + fqdn).bold);
            console.log('');

            helper.exit();
        });
    });
}

function restore(options) {
    assert.strictEqual(typeof options, 'object');

    var provider = options.provider;
    var region = options.region;
    var accessKeyId = options.accessKeyId;
    var secretAccessKey = options.secretAccessKey;
    var backupKey = options.backupKey;
    var backupBucket = options.backupBucket;
    var backup = options.backup;
    var type = options.type;
    var sshKey = options.sshKey;
    var fqdn = options.fqdn;
    var subnet = options.subnet;
    var securityGroup = options.securityGroup;

    if (!provider) helper.missing('provider');
    if (!region) helper.missing('region');
    if (!accessKeyId) helper.missing('access-key-id');
    if (!secretAccessKey) helper.missing('secret-access-key');
    if (!backupKey) helper.missing('backup-key');
    if (!backupBucket) helper.missing('backup-bucket');
    if (!backup) helper.missing('backup');
    if (!type) helper.missing('type');
    if (!sshKey) helper.missing('ssh-key');
    if (!fqdn) helper.missing('fqdn');
    if (!subnet) helper.missing('subnet');
    if (!securityGroup) helper.missing('security-group');

    if (provider !== 'caas' && provider !== 'ec2') helper.exit('--provider must be either "caas" or "ec2"');

    // FIXME
    if (provider === 'caas') helper.exit('caas not yet supported');

    getBackupListing(fqdn, options, function (error, result) {
        if (error) helper.exit(error);

        if (result.length === 0) helper.exit('No backups found. Create one first to restore to.');

        var backupTo = result.filter(function (b) { console.log(b); return b.id === backup; })[0];
        if (!backupTo) helper.exit('Unable to find backup ' + backup + '.');

        var params = {
            region: region,
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            backupBucket: backupBucket,
            backupKey: backupKey,
            backup: backupTo,
            type: type,
            sshKey: sshKey,
            domain: fqdn,
            subnet: subnet,
            securityGroup: securityGroup
        };

        tasks.restore(params, function (error) {
            if (error) helper.exit(error);

            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + fqdn).bold);
            console.log('');

            helper.exit();
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

function login(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    helper.detectCloudronApiEndpoint(cloudron, function (error, result) {
        if (error) return callback(error);

        gCloudronApiEndpoint = result.apiEndpoint;

        console.log();

        if (!options.username || !options.password) console.log('Enter credentials for ' + cloudron.cyan.bold + ':');

        var username = options.username || readlineSync.question('Username: ', {});
        var password = options.password || readlineSync.question('Password: ', { noEchoBack: true });

        superagent.post(createUrl('/api/v1/developer/login')).send({
            username: username,
            password: password
        }).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode === 412) {
                helper.showDeveloperModeNotice(cloudron);
                return login(cloudron, options, callback);
            }
            if (result.statusCode !== 200) {
                console.log('Login failed.'.red);
                return login(cloudron, options, callback);
            }

            console.log('Login successful.'.green);

            callback(null, result.body.token);
        });
    });
}

function listBackups(cloudron, options) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');

    getBackupListing(cloudron, options, function (error, result) {
        if (error) helper.exit(error);

        console.log();

        if (result.length === 0) {
            console.log('No backups have been made.');
            helper.exit();
        }

        var t = new Table();

        result.forEach(function (backup) {
            t.cell('Id', backup.id);
            t.cell('Creation Time', backup.creationTime);
            t.cell('Version', backup.version);
            // t.cell('Apps', backup.dependsOn.join(' '));

            t.newRow();
        });

        console.log(t.toString());

        helper.exit();
    });
}

function createBackup(cloudron, options) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');

    login(cloudron, options, function (error, token) {
        if (error) helper.exit(error);

        superagent.post(createUrl('/api/v1/backups')).query({ access_token: token }).send({}).end(function (error, result) {
            if (error) helper.exit(error);
            if (result.statusCode !== 202) return helper.exit(util.format('Failed to backup box.'.red, result.statusCode, result.text));

            process.stdout.write('Waiting for box backup to finish...');

            function checkStatus() {
                superagent.get(createUrl('/api/v1/cloudron/progress')).query({ access_token: token }).end(function (error, result) {
                    if (error) return helper.exit(error);
                    if (result.statusCode !== 200) return helper.exit(new Error(util.format('Failed to get backup progress.'.red, result.statusCode, result.text)));

                    if (result.body.backup.percent >= 100) {
                        if (result.body.backup.message) return helper.exit(new Error('Backup failed: ' + result.body.backup.message));

                        console.log('\n\nBox is backed up'.green);
                        helper.exit();
                    }

                    process.stdout.write('.');

                    setTimeout(checkStatus, 1000);
                });
            }

            checkStatus();
        });
    });
}

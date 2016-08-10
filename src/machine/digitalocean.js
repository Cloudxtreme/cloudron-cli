'use strict';

var assert = require('assert'),
    async = require('async'),
    aws = require('./aws.js'),
    config = require('../config.js'),
    dns = require('native-dns'),
    hat = require('hat'),
    helper = require('../helper.js'),
    path = require('path'),
    superagent = require('superagent'),
    tld = require('tldjs'),
    util = require('util'),
    versions = require('./versions.js');

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

function getSSHKeyId(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.token, 'string');
    assert.strictEqual(typeof params.sshKey, 'string');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Looking up SSH key ID...');

    superagent.get('https://api.digitalocean.com/v2/account/keys').set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
        if (error) return callback((result && result.body) ? result.body.message : error.message);
        if (result.statusCode !== 200) return callback(util.format('Looking for SSH key IDs failed. %s %j', result.statusCode, result.body));

        var sshKeys = result.body.ssh_keys || [];

        var sshKeyId = null;
        sshKeys.forEach(function (key) { if (key.name === params.sshKey) sshKeyId = key.id; });

        if (!sshKeyId) return callback('No ssh key found with the name ' + params.sshKey);

        params.sshKeyId = sshKeyId;

        console.log(params.sshKeyId);

        callback();
    });
}

function getUserData(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.version, 'string');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof params.awsRegion, 'string');
    assert.strictEqual(typeof params.backupBucket, 'string');
    assert.strictEqual(typeof params.backupKey, 'string');
    assert.strictEqual(typeof params.accessKeyId, 'string');
    assert.strictEqual(typeof params.secretAccessKey, 'string');
    assert.strictEqual(typeof callback, 'function');

    versions.details(params.version, function (error, result) {
        if (error) return callback(error);

        helper.createCertificate(params.domain,  function (error, tlsKey, tlsCert) {
            if (error) return callback(error);

            var data = {
                // installer data
                sourceTarballUrl: result.sourceTarballUrl,

                data: {
                    fqdn: params.domain,
                    isCustomDomain: true,
                    version: params.version,
                    boxVersionsUrl: versions.versionsUrl,
                    provider: 'digitalocean',

                    appstore: {
                        token: '',
                        apiServerOrigin: config.appStoreOrigin()
                    },
                    caas: null,
                    tlsConfig: {
                        provider: process.env.CLOUDRON_TLS_PROVIDER || 'letsencrypt-prod',
                    },
                    tlsCert: tlsCert,
                    tlsKey: tlsKey,

                    appBundle: [], // default app list

                    // obsolete
                    token: '',
                    apiServerOrigin: config.appStoreOrigin(),
                    webServerOrigin: 'https://cloudron.io',

                    restore: {
                        url: params.backupDetails ? params.backupDetails.url : null,
                        key: params.backupDetails ? params.backupDetails.key : null
                    },
                    backupConfig: {
                        provider: 's3',
                        key: params.backupKey,
                        region: params.awsRegion,
                        bucket: params.backupBucket,
                        prefix: params.domain,
                        accessKeyId: params.accessKeyId,
                        secretAccessKey: params.secretAccessKey
                    },
                    dnsConfig: {
                        provider: 'route53',
                        accessKeyId: params.accessKeyId,
                        secretAccessKey: params.secretAccessKey
                    },
                    updateConfig: { prerelease: process.env.CLOUDRON_PRERELEASE ? true : false }
                }
            };

            callback(null, data);
        });
    });
}

function createServer(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof params.region, 'string');
    assert.strictEqual(typeof params.type, 'string');
    assert.strictEqual(typeof params.sshKeyId, 'number');
    assert.strictEqual(typeof params.token, 'string');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Creating server...');

    getUserData(params, function (error, result) {
        if (error) return callback(error);

        var data = {
            name: params.domain,
            region: params.region,
            size: params.type,
            image: 'ubuntu-16-04-x64',
            ssh_keys: [ params.sshKeyId ],
            user_data: JSON.stringify(result),
            backups: false
        };

        superagent.post('https://api.digitalocean.com/v2/droplets').send(data).set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
            if (error) return callback((result && result.body) ? result.body.message : error.message);
            if (result.statusCode !== 202) return callback(util.format('Droplet creation failed. %s %j', result.statusCode, result.body));

            params.instanceId = result.body.droplet.id;
            params.createAction = result.body.links.actions[0];

            console.log(params.instanceId);

            callback();
        });
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
                setTimeout(callback, 2000);
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
    assert.strictEqual(typeof params.instanceId, 'number');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Getting public IP...');

    superagent.get('https://api.digitalocean.com/v2/droplets/' + params.instanceId).set('Authorization', 'Bearer ' + params.token).end(function (error, result) {
        if (error) return callback(error.message);
        if (result.statusCode !== 200) return callback(util.format('Droplet details failed. %s %j', result.statusCode, result.body));

        params.publicIP = result.body.droplet.networks.v4[0].ip_address;

        console.log(params.publicIP);

        callback();
    });
}

function initBaseSystem(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.publicIP, 'string');
    assert.strictEqual(typeof params.sshKey, 'string');
    assert.strictEqual(typeof params.version, 'string');
    assert.strictEqual(typeof callback, 'function');

    function exec(input, callback) {
        var args = input.split(' ');
        var cmd = args.shift();
        var retries = 10;

        helper.exec(cmd, args, function (error) {
            // retry for some time
            if (error && retries) {
                --retries;
                setTimeout(exec.bind(null, input, callback), 1000);
                return;
            }
            if (error) return callback(error);

            callback();
        });
    }

    versions.details(params.version, function (error, result) {
        if (error) return callback(error);

        // TODO fetch from the version
        var initScript = path.join(__dirname, '../../../box/baseimage/initializeBaseUbuntuImage.sh');
        var sshKeyFile = helper.findSSHKey(params.sshKey);

        // TODO set revision
        async.series([
            exec.bind(null, 'scp -P 22 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ' + sshKeyFile + ' ' + initScript + ' root@' + params.publicIP + ':.'),
            exec.bind(null, 'ssh root@' + params.publicIP + ' -tt -p 22 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ' + sshKeyFile + ' curl ' + result.sourceTarballUrl + ' -o /tmp/box.tar.gz'),
            exec.bind(null, 'ssh root@' + params.publicIP + ' -tt -p 22 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ' + sshKeyFile + ' /bin/bash /root/initializeBaseUbuntuImage.sh 1337 digitalocean'),
            exec.bind(null, 'ssh root@' + params.publicIP + ' -tt -p 202 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ' + sshKeyFile + ' systemctl reboot'),
        ], function (error) {
            if (error) return callback('Initializing base image failed. ' + error);

            callback();
        });
    });
}

// the first arg to callback is not an error argument; this is required for async.every
function isChangeSynced(fqdn, publicIP, nameserver, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof publicIP, 'string');
    assert.strictEqual(typeof nameserver, 'string');
    assert.strictEqual(typeof callback, 'function');

    // ns records cannot have cname
    dns.resolve4(nameserver, function (error, nsIps) {
        if (error || !nsIps || nsIps.length === 0) return callback(false);

        async.every(nsIps, function (nsIp, iteratorCallback) {
            var req = dns.Request({
                question: dns.Question({ name: fqdn, type: 'A' }),
                server: { address: nsIp },
                timeout: 5000
            });

            req.on('timeout', function () { return iteratorCallback(false); });

            req.on('message', function (error, message) {
                if (error || !message.answer || message.answer.length === 0) return iteratorCallback(false);
                if (message.answer[0].address !== publicIP) return iteratorCallback(false);

                iteratorCallback(true); // done
            });

            req.send();
        }, callback);
    });
 }

// check if IP change has propagated to every nameserver
function waitForDNS(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof params.publicIP, 'string');
    assert.strictEqual(typeof callback, 'function');

    var adminFqdn = 'my.' + params.domain;

    process.stdout.write('Waiting for DNS...');

    async.forever(function (callback) {
        dns.resolveNs(tld.getDomain(params.domain), function (error, nameservers) {
            if (error) return setTimeout(callback, 5000);
            if (!nameservers) return callback(new Error('Unable to get nameservers'));

            async.every(nameservers, isChangeSynced.bind(null, adminFqdn, params.publicIP), function (synced) {
                process.stdout.write('.');

                // try again if not synced
                setTimeout(function () { callback(synced ? 'done' : null); }, 5000);
            });
        });
    }, function (errorOrDone) {
        if (errorOrDone !== 'done') return callback(errorOrDone);

        process.stdout.write('\n');

        callback();
    });
}

function waitForStatus(params, callback) {
    assert.strictEqual(typeof params, 'object');
    assert.strictEqual(typeof params.domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for Cloudron to be ready...');

    async.forever(function (callback) {
        superagent.get('https://my.' + params.domain + '/api/v1/cloudron/status').redirects(0).timeout(10000).end(function (error, result) {
            if (!error && result.statusCode === 200 && result.body.provider === 'ec2') return callback('done');

            process.stdout.write('.');

            setTimeout(function () { callback(null); }, 1000);
        });
    }, function (errorOrDone) {
        if (errorOrDone !== 'done') return callback(errorOrDone);

        process.stdout.write('\n');

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
    if (!options.backupBucket) helper.missing('backup-bucket');
    if (!options.token) helper.missing('token');
    if (!options.sshKey) helper.missing('ssh-key');
    if (!options.awsRegion) helper.missing('aws-region');

    if (!options.backupKey) {
        console.log();
        console.log('No backup key specified.');
        options.backupKey = hat(256);
        console.log('Generated backup key: ', options.backupKey.bold.cyan);
        console.log('Remember to keep the backup key in a safe location. You will need it to restore your Cloudron!'.yellow);
        console.log();
    }

    var params = {
        token: options.token,
        awsRegion: options.awsRegion,
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

    console.log('Using version %s', version.cyan.bold);

    aws.init({
        region: options.awsRegion,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    var tasks = [
        checkDNSZone.bind(null, params),
        checkS3BucketAccess.bind(null, params),
        getSSHKeyId.bind(null, params),
        createServer.bind(null, params),
        waitForServer.bind(null, params),
        getIp.bind(null, params),
        initBaseSystem.bind(null, params),
        waitForDNS.bind(null, params),
        waitForStatus.bind(null, params)
    ];

    async.series(tasks, function (error) {
        if (error) return callback(error);

        console.log('');
        console.log('Cloudron created with:');
        console.log('  ID:        %s', String(params.instanceId).cyan);
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

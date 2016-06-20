'use strict';

var assert = require('assert'),
    async = require('async'),
    aws = require('./aws.js'),
    config = require('../config.js'),
    debug = require('debug')('tasks'),
    dns = require('native-dns'),
    execFile = require('child_process').execFile,
    helper = require('../helper.js'),
    os = require('os'),
    path = require('path'),
    safe = require('safetydance'),
    superagent = require('superagent'),
    tld = require('tldjs'),
    versions = require('./versions.js');

exports = module.exports = {
    create: create,
    restore: restore,
    upgrade: upgrade
};

// gParams holds input values
var gParams = null;

// those hold output values
var gInstanceId = null;
var gPublicIP = null;

function checkDNSZone(callback) {
    assert.strictEqual(typeof callback, 'function');

    console.log('Checking DNS zone...');

    aws.checkIfDNSZoneExists(gParams.domain, function (error) {
        if (error) return callback(error);

        callback();
    });
}

function createServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    console.log('Creating server...');

    getUserData(function (error, userData) {
        if (error) return callback(error);

        var params = {
            version: gParams.version,
            type: gParams.type,
            sshKey: gParams.sshKey,
            subnet: gParams.subnet,
            securityGroup: gParams.securityGroup,
            userData: userData
        };

        aws.create(params, function (error, instanceId) {
            if (error) return callback(error);

            gInstanceId = instanceId;

            callback();
        });
    });
}

function waitForServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for server to come up...');

    async.forever(function (callback) {
        aws.state(gInstanceId, function (error, state) {
            if (error) return callback(error);
            if (state === 'running') return callback('done');

            process.stdout.write('.');

            setTimeout(callback, 1000);
        });
    }, function (doneOrError) {
        if (doneOrError !== 'done') return callback(doneOrError);

        process.stdout.write('\n');

        callback();
    });

}

function getIp(callback) {
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Getting public IP...');

    aws.publicIP(gInstanceId, function (error, result) {
        if (error) return callback(error);

        gPublicIP = result;

        console.log(gPublicIP);

        callback();
    });
}

function createCertificate(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('createCertificate: %s', domain);

    var outdir = path.join(os.tmpdir(), domain); // certs are generated here

    var args = [
        'US', 'California', 'San Francisco', 'Cloudron Company', 'Cloudron', domain, 'cert@cloudron.io', outdir
    ];

    var certificateGenerationScript = path.join(__dirname, '../../scripts/generate_certificate.sh');

    execFile(certificateGenerationScript, args, {}, function (error, stdout, stderr) {
        if (error) return callback(error);

        debug('createCertificate: %s success.', domain);
        debug('stdout: %s', stdout.toString('utf8'));
        debug('stderr: %s', stderr.toString('utf8'));

        var key = safe.fs.readFileSync(path.join(outdir, 'host.key'), 'utf8');
        var cert = safe.fs.readFileSync(path.join(outdir, 'host.cert'), 'utf8');

        callback(null, key, cert);
    });
}

function getUserData(callback) {
    assert.strictEqual(typeof callback, 'function');

    versions.details(gParams.version, function (error, result) {
        if (error) return callback(error);

        createCertificate(gParams.domain,  function (error, tlsKey, tlsCert) {
            if (error) return callback(error);

            var data = {
                // installer data
                sourceTarballUrl: result.sourceTarballUrl,

                data: {
                    fqdn: gParams.domain,
                    isCustomDomain: true,
                    version: gParams.version,
                    boxVersionsUrl: versions.versionsUrl,
                    provider: 'ec2',

                    appstore: {
                        token: '',
                        apiServerOrigin: 'https://api.dev.cloudron.io'
                    },
                    caas: {
                        token: '',
                        apiServerOrigin: 'https://api.dev.cloudron.io',
                        webServerOrigin: 'https://dev.cloudron.io'
                    },
                    tlsConfig: {
                        provider: 'letsencrypt-dev',
                    },
                    tlsCert: tlsCert,
                    tlsKey: tlsKey,

                    appBundle: [], // default app list

                    // obsolete
                    token: '',
                    apiServerOrigin: 'https://api.dev.cloudron.io',
                    webServerOrigin: 'https://dev.cloudron.io',

                    restore: {
                        url: gParams.backupDetails ? gParams.backupDetails.url : null,
                        key: gParams.backupDetails ? gParams.backupDetails.key : null
                    },
                    backupConfig: {
                        provider: 's3',
                        key: gParams.backupKey,
                        region: gParams.region,
                        bucket: gParams.backupBucket,
                        prefix: gParams.domain,
                        accessKeyId: gParams.accessKeyId,
                        secretAccessKey: gParams.secretAccessKey
                    },
                    dnsConfig: {
                        provider: 'route53',
                        accessKeyId: gParams.accessKeyId,
                        secretAccessKey: gParams.secretAccessKey
                    },
                    updateConfig: { prerelease: true }
                }
            };

            debug('Using user data:', data);

            callback(null, data);
        });
    });
}

// the first arg to callback is not an error argument; this is required for async.every
function isChangeSynced(domain, nameserver, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof nameserver, 'string');
    assert.strictEqual(typeof callback, 'function');

    // ns records cannot have cname
    dns.resolve4(nameserver, function (error, nsIps) {
        if (error || !nsIps || nsIps.length === 0) return callback(false);

        async.every(nsIps, function (nsIp, iteratorCallback) {
            var req = dns.Request({
                question: dns.Question({ name: domain, type: 'A' }),
                server: { address: nsIp },
                timeout: 5000
            });

            req.on('timeout', function () { return iteratorCallback(false); });

            req.on('message', function (error, message) {
                if (error || !message.answer || message.answer.length === 0) return iteratorCallback(false);
                if (message.answer[0].address !== gPublicIP) return iteratorCallback(false);

                iteratorCallback(true); // done
            });

            req.send();
        }, callback);
    });
 }

// check if IP change has propagated to every nameserver
function waitForDNS(callback) {
    assert.strictEqual(typeof callback, 'function');

    var adminFqdn = 'my.' + gParams.domain;

    process.stdout.write('Waiting for DNS...');

    async.forever(function (callback) {
        dns.resolveNs(tld.getDomain(gParams.domain), function (error, nameservers) {
            if (error || !nameservers) return callback(error || new Error('Unable to get nameservers'));

            async.every(nameservers, isChangeSynced.bind(null, adminFqdn), function (synced) {
                process.stdout.write('.');

                // try again if not synced
                setTimeout(function () { callback(synced ? 'done' : null); }, 2000);
            });
        });
    }, function (errorOrDone) {
        if (errorOrDone !== 'done') return callback(errorOrDone);

        process.stdout.write('\n');

        callback();
    });
}

function waitForStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    process.stdout.write('Waiting for Cloudron become alive...');

    async.forever(function (callback) {
        superagent.get('https://my.' + gParams.domain + '/api/v1/cloudron/status').end(function (error, result) {
            if (!error & result.statusCode === 200) return callback('done');

            process.stdout.write('.');

            setTimeout(function () { callback(null); }, 1000);
        });
    }, function (errorOrDone) {
        if (errorOrDone !== 'done') return callback(errorOrDone);

        process.stdout.write('\n');

        callback();
    });
}

function getBackupDetails(callback) {
    assert.strictEqual(typeof callback, 'function');

    console.log('Getting backup details...');

    aws.getBackupUrl(gParams.backupBucket, gParams.domain, gParams.backup.id, function (error, result) {
        if (error) return callback(error);

        gParams.backupDetails = {
            key: gParams.backupKey,
            url: result
        };

        callback();
    });
}

function createBackup(callback) {
    assert.strictEqual(typeof callback, 'function');

    helper.exec('ssh', helper.getSSH(config.apiEndpoint(), gParams.sshKeyFile, ' curl --fail -X POST http://127.0.0.1:3001/api/v1/backup'), helper.waitForBackupFinish.bind(null, callback));
}

function retireOldCloudron(callback) {
    assert.strictEqual(typeof callback, 'function');

    helper.exec('ssh', helper.getSSH(config.apiEndpoint(), gParams.sshKeyFile, ' curl --fail -X POST http://127.0.0.1:3001/api/v1/retire'), callback);
}

function create(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.region, 'string');
    assert.strictEqual(typeof options.version, 'string');
    assert.strictEqual(typeof options.backupKey, 'string');
    assert.strictEqual(typeof options.backupBucket, 'string');
    assert.strictEqual(typeof options.accessKeyId, 'string');
    assert.strictEqual(typeof options.secretAccessKey, 'string');
    assert.strictEqual(typeof options.type, 'string');
    assert.strictEqual(typeof options.sshKey, 'string');
    assert.strictEqual(typeof options.subnet, 'string');
    assert.strictEqual(typeof options.domain, 'string');
    assert.strictEqual(typeof options.securityGroup, 'string');
    assert.strictEqual(typeof callback, 'function');

    console.log('Using version %s', options.version.cyan.bold);

    aws.init({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    gParams = options;

    var tasks = [
        checkDNSZone,
        createServer,
        waitForServer,
        getIp,
        waitForDNS,
        waitForStatus
    ];

    async.series(tasks, function (error) {
        if (error) return callback(error);

        console.log('');
        console.log('Cloudron created with:');
        console.log('  ID:        %s', gInstanceId.cyan);
        console.log('  Public IP: %s', gPublicIP.cyan);
        console.log('');

        callback();
    });
}

function restore(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.region, 'string');
    assert.strictEqual(typeof options.backup, 'object');
    assert.strictEqual(typeof options.backupKey, 'string');
    assert.strictEqual(typeof options.backupBucket, 'string');
    assert.strictEqual(typeof options.accessKeyId, 'string');
    assert.strictEqual(typeof options.secretAccessKey, 'string');
    assert.strictEqual(typeof options.type, 'string');
    assert.strictEqual(typeof options.sshKey, 'string');
    assert.strictEqual(typeof options.subnet, 'string');
    assert.strictEqual(typeof options.domain, 'string');
    assert.strictEqual(typeof options.securityGroup, 'string');
    assert.strictEqual(typeof callback, 'function');

    console.log('Restoring %s to backup %s with version %s', options.domain.cyan.bold, options.backup.id.cyan.bold, options.backup.version.cyan.bold);

    aws.init({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    gParams = options;

    // use the version of the backup
    gParams.version = options.backup.version;

    var tasks = [
        checkDNSZone,
        getBackupDetails,
        createServer,
        waitForServer,
        getIp,
        waitForDNS,
        waitForStatus
    ];

    async.series(tasks, function (error) {
        if (error) return callback(error);

        console.log('');
        console.log('Cloudron created with:');
        console.log('  ID:        %s', gInstanceId.cyan);
        console.log('  Public IP: %s', gPublicIP.cyan);
        console.log('');

        callback();
    });
}

function upgrade(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.version, 'string');
    assert.strictEqual(typeof options.accessKeyId, 'string');
    assert.strictEqual(typeof options.secretAccessKey, 'string');
    assert.strictEqual(typeof options.region, 'string');
    assert.strictEqual(typeof options.instanceId, 'string');
    assert.strictEqual(typeof callback, 'function');

    console.log('Upgrading %s to version %s...', options.instanceId.cyan.bold, options.version.cyan.bold);

    aws.init({
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
    });

    gParams = options;
    gParams.oldInstanceId = options.oldInstanceId;

    var tasks = [
        createBackup,
        getBackupDetails,
        retireOldCloudron,
        createServer,
        waitForServer,
        getIp,
        waitForDNS,
        waitForStatus
    ];

    async.series(tasks, function (error) {
        if (error) return callback(error);

        console.log('');
        console.log('Cloudron upgraded with:');
        console.log('  ID:        %s', gInstanceId.cyan);
        console.log('');

        callback();
    });
}

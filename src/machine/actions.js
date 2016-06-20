'use strict';

var assert = require('assert'),
    caas = require('./caas.js'),
    ec2 = require('./ec2.js'),
    helper = require('../helper.js'),
    readlineSync = require('readline-sync'),
    superagent = require('superagent'),
    Table = require('easy-table'),
    util = require('util'),
    versions = require('./versions.js');

exports = module.exports = {
    create: create,
    restore: restore,
    migrate: migrate,
    listBackups: listBackups,
    createBackup: createBackup,
    eventlog: eventlog,
    logs: logs,
    ssh: ssh,
    updateOrUpgrade: updateOrUpgrade
};

var gCloudronApiEndpoint = null;
var gCloudronToken = null;

function createUrl(api) {
    assert.strictEqual(typeof gCloudronApiEndpoint, 'string');
    assert.strictEqual(typeof api, 'string');

    return 'https://' + gCloudronApiEndpoint + api;
}

function getBackupListing(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (options.provider === 'caas') {
        console.log('Using caas backup listing');
        return caas.getBackupListing(cloudron, {}, callback);
    } else if (options.provider === 'ec2') {
        console.log('Using s3 backup listing');
        return ec2.getBackupListing(cloudron, options, callback);
    } else if (options.provider) {
        helper.exit('--provider must be either "caas" or "ec2"');
    }

    login(cloudron, options, function (error, token) {
        if (error) {
            console.error(error);
            helper.exit('Try using the --provider argument');
        }

        superagent.get(createUrl('/api/v1/backups')).query({ access_token: token }).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(util.format('Failed to list backups.'.red, result.statusCode, result.text));

            callback(null, result.body.backups);
        });
    });
}

function waitForBackupFinish(callback) {
    if (callback) assert.strictEqual(typeof callback, 'function');
    else callback = helper.exit;

    process.stdout.write('Waiting for backup to finish...');

    (function checkStatus() {
        superagent.get(createUrl('/api/v1/cloudron/progress')).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(new Error(util.format('Failed to get backup progress.'.red, result.statusCode, result.text)));

            if (result.body.backup.percent >= 100) {
                if (result.body.backup.message) return callback(new Error('Backup failed: ' + result.body.backup.message));
                return callback();
            }

            process.stdout.write('.');

            setTimeout(checkStatus, 1000);
        });
    })();
}

function create(provider, options) {
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof options, 'object');

    if (!options.release) helper.missing('release');
    if (!options.fqdn) helper.missing('fqdn');
    if (!options.type) helper.missing('type');
    if (!options.region) helper.missing('region');

    versions.resolve(options.release, function (error, result) {
        if (error) helper.exit(error);

        var func;
        if (provider === 'ec2') func = ec2.create;
        else if (provider === 'caas') func = caas.create;
        else helper.exit('<provider> must be either "caas" or "ec2"');

        func(options, result, function (error) {
            if (error) helper.exit(error);

            console.log('');
            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + options.fqdn).bold);
            console.log('');

            helper.exit();
        });
    });
}

function restore(options) {
    assert.strictEqual(typeof options, 'object');

    if (!options.provider) helper.missing('provider');
    if (!options.backup) helper.missing('backup');
    if (!options.fqdn) helper.missing('fqdn');

    getBackupListing(options.fqdn, options, function (error, result) {
        if (error) helper.exit(error);

        if (result.length === 0) helper.exit('No backups found. Create one first to restore to.');

        var backupTo = result.filter(function (b) { return b.id === options.backup; })[0];
        if (!backupTo) helper.exit('Unable to find backup ' + options.backup + '.');

        var func;
        if (options.provider === 'ec2') func = ec2.restore;
        else if (options.provider === 'caas') func = caas.restore;
        else helper.exit('--provider must be either "caas" or "ec2"');

        func(options, backupTo, function (error) {
            if (error) helper.exit(error);

            console.log('');
            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + options.fqdn).bold);
            console.log('');

            helper.exit();
        });
    });
}

function migrate(options) {
    assert.strictEqual(typeof options, 'object');

    if (!options.provider) helper.missing('provider');  // FIXME autodetect provider
    if (!options.fqdnFrom) helper.missing('fqdn-from');
    if (!options.fqdnTo) helper.missing('fqdn-to');
    if (!options.type) helper.missing('type');
    if (!options.region) helper.missing('region');

    if (options.provider === 'caas') {
        if (!options.sshKeyFile) helper.missing('ssh-key-file');

        // TODO verify the sshKeyFile path

        // TODO my god this is ugly
        helper.detectCloudronApiEndpoint(options.fqdnFrom, function (error, result) {
            if (error) helper.exit(error);

            gCloudronApiEndpoint = result.apiEndpoint;

            helper.exec('ssh', helper.getSSH(result.apiEndpoint, options.sshKeyFile, ' curl --fail -X POST http://127.0.0.1:3001/api/v1/backup', options.sshUser), function (error) {
                if (error) helper.exit(error);

                waitForBackupFinish(function (error) {
                    if (error) helper.exit(error);

                    caas.getBackupListing(options.fqdnFrom, {}, function (error, result) {
                        if (error) helper.exit(error);
                        if (result.length === 0) helper.exit('Missing backup, this should not happen!');

                        caas.migrate(options, result[0], function (error) {
                            if (error) helper.exit(error);

                            console.log('');
                            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + options.fqdnTo).bold);
                            console.log('');
                        });
                    });
                });
            });
        });
    } else if (options.provider === 'ec2') {
        helper.exit('not implemented');
    } else {
        helper.exit('--provider must be either "caas" or "ec2"');
    }
}

function login(cloudron, options, callback) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    helper.detectCloudronApiEndpoint(cloudron, function (error, result) {
        if (error) return callback(error);

        gCloudronApiEndpoint = result.apiEndpoint;

        // skip if already set
        if (gCloudronToken) return callback(null, gCloudronToken);

        console.log('');

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

            gCloudronToken = result.body.token;

            callback(null, result.body.token);
        });
    });
}

function listBackups(cloudron, options) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');

    getBackupListing(cloudron, options, function (error, result) {
        if (error) helper.exit(error);

        console.log('');

        if (result.length === 0) {
            console.log('No backups have been made.');
            helper.exit();
        }

        var t = new Table();

        result.forEach(function (backup) {
            t.cell('Id', backup.id);
            t.cell('Creation Time', backup.creationTime);
            t.cell('Version', backup.version);

            t.newRow();
        });

        console.log(t.toString());

        helper.exit();
    });
}

function createBackup(cloudron, options) {
    assert.strictEqual(typeof cloudron, 'string');
    assert.strictEqual(typeof options, 'object');

    function done() {
        console.log('\n\nCloudron is backed up'.green);
        helper.exit();
    }

    if (options.ssh) {
        if (!options.sshKeyFile) helper.missing('ssh-key-file');

        // TODO verify the sshKeyFile path

        helper.detectCloudronApiEndpoint(cloudron, function (error, result) {
            if (error) helper.exit(error);

            gCloudronApiEndpoint = result.apiEndpoint;

            helper.exec('ssh', helper.getSSH(result.apiEndpoint, options.sshKeyFile, ' curl --fail -X POST http://127.0.0.1:3001/api/v1/backup', options.sshUser), waitForBackupFinish.bind(null, done));
        });
    } else {
        login(cloudron, options, function (error, token) {
            if (error) helper.exit(error);

            superagent.post(createUrl('/api/v1/backups')).query({ access_token: token }).send({}).end(function (error, result) {
                if (error) helper.exit(error);
                if (result.statusCode !== 202) return helper.exit(util.format('Failed to backup Cloudron.'.red, result.statusCode, result.text));

                waitForBackupFinish(done);
            });
        });
    }
}

function eventlog(fqdn, options) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof options, 'object');

    if (options.ssh) {
        if (!options.sshKeyFile) helper.missing('ssh-key-file');

        helper.detectCloudronApiEndpoint(fqdn, function (error, result) {
            if (error) helper.exit(error);

            if (options.full) {
                helper.exec('ssh', helper.getSSH(result.apiEndpoint, options.sshKeyFile, ' mysql -uroot -ppassword -e "SELECT creationTime,action,source,data FROM box.eventlog ORDER BY creationTime DESC"', options.sshUser));
            } else {
                helper.exec('ssh', helper.getSSH(result.apiEndpoint, options.sshKeyFile, ' mysql -uroot -ppassword -e "SELECT creationTime,action,source,LEFT(data,50) AS data_preview FROM box.eventlog ORDER BY creationTime DESC"', options.sshUser));
            }
        });
    } else {
        login(fqdn, options, function (error, token) {
            if (error) helper.exit(error);

            superagent.get(createUrl('/api/v1/eventlog')).query({ access_token: token }).send({}).end(function (error, result) {
                if (error) helper.exit(error);
                if (result.statusCode !== 200) return helper.exit(util.format('Failed to fetch eventlog.'.red, result.statusCode, result.text));

                var t = new Table();

                result.body.eventlogs.forEach(function (event) {
                    t.cell('creationTime', event.creationTime);
                    t.cell('action', event.action);
                    t.cell('source', event.source.username || event.source.userId || event.source.ip);
                    t.cell('data_preview', options.full ? JSON.stringify(event.data) : JSON.stringify(event.data).slice(-50));

                    t.newRow();
                });

                console.log(t.toString());

                helper.exit();
            });
        });
    }
}

function logs(fqdn, options) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof options, 'object');

    if (!options.sshKeyFile) helper.missing('ssh-key-file');

    helper.detectCloudronApiEndpoint(fqdn, function (error, result) {
        var ip = null;

        if (error) {
            if (helper.isIp(fqdn)) {
                ip = fqdn;
            } else {
                helper.exit(error);
            }
        }
        helper.exec('ssh', helper.getSSH(ip || result.apiEndpoint, options.sshKeyFile, 'journalctl -fa', options.sshUser));
    });
}

function ssh(fqdn, cmds, options) {
    assert.strictEqual(typeof fqdn, 'string');
    assert(Array.isArray(cmds));
    assert.strictEqual(typeof options, 'object');

    if (!options.sshKeyFile) helper.missing('ssh-key-file');

    helper.detectCloudronApiEndpoint(fqdn, function (error, result) {
        var ip = null;

        if (error) {
            if (helper.isIp(fqdn)) {
                ip = fqdn;
            } else {
                helper.exit(error);
            }
        }

        helper.exec('ssh', helper.getSSH(ip || result.apiEndpoint, options.sshKeyFile, cmds, options.sshUser));
    });
}

function waitForUpdateFinish(callback) {
    if (callback) assert.strictEqual(typeof callback, 'function');
    else callback = helper.exit;

    process.stdout.write('Waiting for update to finish...');

    (function checkStatus() {
        superagent.get(createUrl('/api/v1/cloudron/progress')).end(function (error, result) {
            if (error) return callback(error);
            if (result.statusCode !== 200) return callback(new Error(util.format('Failed to get update progress.'.red, result.statusCode, result.text)));

            if (result.body.update.percent >= 100) {
                if (result.body.update.message) return callback(new Error('Update failed: ' + result.body.update.message));
                return callback();
            }

            process.stdout.write('.');

            setTimeout(checkStatus, 1000);
        });
    })();
}

// calls the rest api to update and upgrade
function performUpdate(cloudron, options) {
    assert.strictEqual(typeof gCloudronToken, 'string');
    assert.strictEqual(typeof cloudron, 'object');
    assert.strictEqual(typeof options, 'object');

    console.log('Updating...');

    superagent.post(createUrl('/api/v1/cloudron/update')).query({ access_token: gCloudronToken }).send({}).end(function (error, result) {
        if (error) helper.exit(error);
        if (result.statusCode !== 202) return helper.exit(util.format('Failed to update Cloudron.'.red, result.statusCode, result.text));

        waitForUpdateFinish();
    });
}

// performs a upgrade for selfhosters
function performUpgrade(cloudron, options) {
    assert.strictEqual(typeof gCloudronToken, 'string');
    assert.strictEqual(typeof cloudron, 'object');
    assert.strictEqual(typeof options, 'object');

    console.log('Upgrading...');

    if (cloudron.provider === 'caas') {
        superagent.post(createUrl('/api/v1/cloudron/update')).query({ access_token: gCloudronToken }).send({}).end(function (error, result) {
            if (error) helper.exit(error);
            if (result.statusCode !== 202) return helper.exit(util.format('Failed to update Cloudron.'.red, result.statusCode, result.text));

            waitForUpdateFinish();
        });
    } else {
        helper.exit('Not implemented');
    }
}

function updateOrUpgrade(fqdn, options) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof options, 'object');

    login(fqdn, options, function (error, token) {
        if (error) helper.exit(error);

        superagent.get(createUrl('/api/v1/cloudron/config')).query({ access_token: token }).send({}).end(function (error, result) {
            if (error) helper.exit(error);
            if (result.statusCode !== 200) return helper.exit(util.format('Failed to get Cloudron configuration.'.red, result.statusCode, result.text));
            if (!result.body.update || !result.body.update.box) return helper.exit('No update available.'.red);

            var boxUpdate = result.body.update.box;

            console.log('New version %s available.', boxUpdate.version.cyan);
            console.log('');
            console.log('Changelog:');
            boxUpdate.changelog.forEach(function (c) { console.log('  * ' + c.bold.white); });
            console.log('');

            if (boxUpdate.upgrade) {
                console.log('This is an upgrade and will result in a few minutes of downtime!'.red);

                var answer = readlineSync.question('Perform upgrade now (y/n)? ');
                if (answer !== 'y') return helper.exit();

                performUpgrade(result.body, options);
            } else {
                performUpdate(result.body, options);
            }
        });
    });
}

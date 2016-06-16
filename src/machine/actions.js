'use strict';

var assert = require('assert'),
    tasks = require('./tasks.js'),
    util = require('util'),
    versions = require('./versions.js');

require('colors');

exports = module.exports = {
    create: create
};

function exit(error) {
    if (error instanceof Error) console.log(error.message.red);
    else if (error) console.error(util.format.apply(null, Array.prototype.slice.call(arguments)).red);
    process.exit(error ? 1 : 0);
}

function missing(argument) {
    exit('You must specify --' + argument);
}

function create(options) {
    var region = options.parent.region;
    var accessKeyId = options.parent.accessKeyId;
    var secretAccessKey = options.parent.secretAccessKey;
    var backupBucket = options.parent.backupBucket;
    var release = options.release;
    var type = options.type;
    var key = options.key;
    var domain = options.domain;
    var subnet = options.subnet;
    var securityGroup = options.securityGroup;

    if (!region) missing('region');
    if (!accessKeyId) missing('access-key-id');
    if (!secretAccessKey) missing('secret-access-key');
    if (!backupBucket) missing('backup-bucket');
    if (!release) missing('release');
    if (!type) missing('type');
    if (!key) missing('key');
    if (!domain) missing('domain');
    if (!subnet) missing('subnet');
    if (!securityGroup) missing('security-group');

    versions.resolve(release, function (error, result) {
        if (error) exit(error);

        var params = {
            region: region,
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            backupBucket: backupBucket,
            version: result,
            type: type,
            key: key,
            domain: domain,
            subnet: subnet,
            securityGroup: securityGroup
        };

        tasks.create(params, function (error) {
            if (error) exit(error);

            console.log('Done.'.green, 'You can now use your Cloudron at ', String('https://my.' + domain).bold);
            console.log('');

            exit();
        });
    });
}

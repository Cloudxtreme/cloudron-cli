'use strict';

var assert = require('assert'),
    AWS = require('aws-sdk'),
    versions = require('./versions.js'),
    debug = require('debug')('aws');

exports = module.exports = {
    init: init,
    create: create,
    state: state,
    publicIP: publicIP,
    checkIfDNSZoneExists: checkIfDNSZoneExists,
    getBackupDetails: getBackupDetails,
    listBackups: listBackups
};

var gEC2 = null;
var gRoute53 = null;
var gS3 = null;

function init(options) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.region, 'string');
    assert.strictEqual(typeof options.accessKeyId, 'string');
    assert.strictEqual(typeof options.secretAccessKey, 'string');

    gEC2 = new AWS.EC2(options);
    gRoute53 = new AWS.Route53(options);
    gS3 = new AWS.S3(options);
}

function getImageDetails(imageId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof imageId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        ImageIds: [ imageId ]
    };

    gEC2.describeImages(params, function (error, result) {
        if (error) return callback(error);

        callback(null, result.Images[0]);
    });
}

function create(options, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.version, 'string');
    assert.strictEqual(typeof options.type, 'string');
    assert.strictEqual(typeof options.key, 'string');
    assert.strictEqual(typeof options.subnet, 'string');
    assert.strictEqual(typeof options.securityGroup, 'string');
    assert.strictEqual(typeof options.userData, 'object');
    assert.strictEqual(typeof callback, 'function');

    versions.details(options.version, function (error, result) {
        if (error) return callback(error);

        getImageDetails(result.ami, function (error, amiDetails) {
            if (error) return callback(error);

            var mainBlockDevice = amiDetails.BlockDeviceMappings.filter(function (d) { return !!d.Ebs; })[0];
            if (!mainBlockDevice) return callback(new Error('Unable to detect main block device'));

            var params = {
                ImageId: result.ami,
                MinCount: 1,
                MaxCount: 1,
                InstanceType: options.type,
                KeyName: options.key,
                NetworkInterfaces: [{
                    SubnetId: options.subnet,
                    AssociatePublicIpAddress: true,
                    Groups: [ options.securityGroup ],
                    DeviceIndex: 0
                }],
                BlockDeviceMappings: [{
                    DeviceName: '/dev/xvda',
                    Ebs: {
                        SnapshotId: mainBlockDevice.Ebs.SnapshotId,
                        VolumeSize: 40,
                        DeleteOnTermination: true,
                        VolumeType: 'gp2'
                    }
                }, {
                    DeviceName: mainBlockDevice.DeviceName,
                    NoDevice: ''
                }],
                UserData: (new Buffer(JSON.stringify(options.userData))).toString('base64')
            };

            debug('create with params:', params);

            gEC2.runInstances(params, function (error, result) {
                if (error) return callback(error);

                debug('result:', result);

                callback(null, result.Instances[0].InstanceId);
            });
        });
    });
}

function state(instanceId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof instanceId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        IncludeAllInstances: true,
        InstanceIds: [ instanceId ]
    };

    debug('get state with params:', params);

    gEC2.describeInstanceStatus(params, function (error, result) {
        if (error && error.errno === 'EPROTO') return callback(null, null);
        if (error) return callback(error);

        debug('result:', result);

        if (!result.InstanceStatuses[0]) return callback(null, null);

        callback(null, result.InstanceStatuses[0].InstanceState.Name);
    });
}

function publicIP(instanceId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof instanceId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        InstanceIds: [ instanceId ]
    };

    debug('get public ip with params:', params);

    gEC2.describeInstances(params, function (error, result) {
        if (error) return callback(error);

        debug('result:', result);

        callback(null, result.Reservations[0].Instances[0].PublicIpAddress);
    });
}

function checkIfDNSZoneExists(domain, callback) {
    assert.strictEqual(typeof gRoute53, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
    };

    debug('get hosted zone with params:', params);

    gRoute53.listHostedZones(params, function (error, result) {
        if (error) return callback(error);

        debug('available zones:', result);

        var exists = result.HostedZones.some(function (zone) { return zone.Name === (domain + '.'); });

        debug('requested zone found: %s', exists ? 'yes' : 'no');

        callback(exists ? null : new Error('Please create a hosted zone on Route53 for this domain first.'));
    });
}

function getBackupDetails(bucket, prefix, backupId, callback) {
    assert.strictEqual(typeof gS3, 'object');
    assert.strictEqual(typeof bucket, 'string');
    assert.strictEqual(typeof prefix, 'string');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        Bucket: bucket,
        Key: prefix + '/' + backupId,
        Expires: 60 * 120 /* 120 minutes */
    };

    debug('getBackupDetails:', params);

    var url = gS3.getSignedUrl('getObject', params);

    var data = {
        key: 'somesecretkey',   // FIXME
        url: url
    };

    callback(null, data);
}

function listBackups(bucket, prefix, callback) {
    assert.strictEqual(typeof gS3, 'object');
    assert.strictEqual(typeof bucket, 'string');
    assert.strictEqual(typeof prefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        Bucket: bucket,
        Prefix: prefix
    };

    gS3.listObjects(params, function(error, data) {
        if (error) return callback(error);

        var backups = [];
        var contents = data.Contents;

        for (var i = 0; i < contents.length; ++i) {
            var match = contents[i].Key.match(/\/backup_(.*)-v(.*).tar.gz$/);
            if (!match) continue;

            var date = new Date(match[1]);
            if (date.toString() === 'Invalid Date') continue;

            backups.push({
                id: contents[i].Key.split('/')[1],
                creationTime: date.toISOString(),
                version: match[2],
                filename: contents[i].Key.split('/')[1]
            });
        }

        // backup results are sorted alphabetically by filename
        return callback(null, backups);
    });
}

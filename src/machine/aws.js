'use strict';

var assert = require('assert'),
    AWS = require('aws-sdk'),
    versions = require('./versions.js'),
    debug = require('debug')('aws');

exports = module.exports = {
    init: init,
    createVPC: createVPC,
    getVPCDetails: getVPCDetails,
    createSubnet: createSubnet,
    getSubnetDetails: getSubnetDetails,
    createInternetGateway: createInternetGateway,
    createSecurityGroup: createSecurityGroup,
    create: create,
    terminateInstance: terminateInstance,
    state: state,
    publicIP: publicIP,
    checkIfDNSZoneExists: checkIfDNSZoneExists,
    checkS3BucketAccess: checkS3BucketAccess,
    getBackupUrl: getBackupUrl,
    listBackups: listBackups,
    getInstanceDetails: getInstanceDetails,
    getVolumeDetails: getVolumeDetails
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

function createVPC(callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        CidrBlock: '10.0.0.0/28',
        InstanceTenancy: 'default'
    };

    gEC2.createVpc(params, function (error, result) {
        if (error) return callback(error);

        var params = {
            Resources: [ result.Vpc.VpcId ],
            Tags: [{
                Key: 'Name',
                Value: 'Cloudron'
            }]
        };

        gEC2.createTags(params, function (error) {
            if (error) return callback(error);

            callback(null, result.Vpc.VpcId);
        });
    });
}

function getVPCDetails(vpcId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof vpcId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        VpcIds: [ vpcId ]
    };

    gEC2.describeVpcs(params, function (error, result) {
        if (error) return callback(error);

        callback(null, result.Vpcs[0]);
    });
}

function createSubnet(vpcId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof vpcId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        CidrBlock: '10.0.0.0/28',
        VpcId: vpcId
    };

    gEC2.createSubnet(params, function (error, result) {
        if (error) return callback(error);

        var params = {
            Resources: [ result.Subnet.SubnetId ],
            Tags: [{
                Key: 'Name',
                Value: 'Cloudron'
            }]
        };

        gEC2.createTags(params, function (error) {
            if (error) return callback(error);

            callback(null, result.Subnet.SubnetId);
        });
    });
}

function createInternetGateway(vpcId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof vpcId, 'string');
    assert.strictEqual(typeof callback, 'function');

    gEC2.createInternetGateway({}, function (error, result) {
        if (error) return callback(error);

        var gatewayId = result.InternetGateway.InternetGatewayId;

        var params = {
            InternetGatewayId: gatewayId,
            VpcId: vpcId
        };

        gEC2.attachInternetGateway(params, function (error) {
            if (error) return callback(error);

            var params = {
                Filters: [{
                    Name: 'vpc-id',
                    Values: [ vpcId ]
                }]
            };

            gEC2.describeRouteTables(params, function (error, result) {
                if (error) return callback(error);
                if (result.RouteTables.length === 0) return callback(new Error('Unable to find routing table for VPC'));

                var params = {
                    DestinationCidrBlock: '0.0.0.0/0',
                    RouteTableId: result.RouteTables[0].RouteTableId,
                    GatewayId: gatewayId,
                };

                gEC2.createRoute(params, function (error) {
                    if (error) return callback(error);

                    callback(null, gatewayId);
                });
            });
        });
    });
}

function createSecurityGroup(vpcId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof vpcId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        Description: 'Cloudron',
        GroupName: 'Cloudron',
        VpcId: vpcId
    };

    gEC2.createSecurityGroup(params, function (error, result) {
        if (error) return callback(error);

        var securityGroupId = result.GroupId;

        var params = {
            GroupId: securityGroupId,
            FromPort: 0,
            ToPort: 65535,
            IpProtocol: '-1',
            CidrIp: '0.0.0.0/0'
        };

        gEC2.authorizeSecurityGroupIngress(params, function (error) {
            if (error) return callback(error);

            callback(null, securityGroupId);
        });
    });
}
function getSubnetDetails(subnetId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof subnetId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        SubnetIds: [ subnetId ]
    };

    gEC2.describeSubnets(params, function (error, result) {
        if (error) return callback(error);

        callback(null, result.Subnets[0]);
    });
}

function create(options, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof options.version, 'string');
    assert.strictEqual(typeof options.region, 'string');
    assert.strictEqual(typeof options.type, 'string');
    assert.strictEqual(typeof options.size, 'number');
    assert.strictEqual(typeof options.sshKey, 'string');
    assert.strictEqual(typeof options.subnet, 'string');
    assert.strictEqual(typeof options.securityGroup, 'string');
    assert.strictEqual(typeof options.userData, 'object');
    assert.strictEqual(typeof callback, 'function');

    versions.details(options.version, function (error, result) {
        if (error) return callback(error);
        if (!result.ami) return callback('This version does not have an EC2 image.');

        var ami = result.ami.filter(function (a) { return a.region === options.region; })[0];
        if (!ami) return callback('This version is not available in region ' + options.region);

        getImageDetails(ami.id, function (error, amiDetails) {
            if (error) return callback(error);

            var mainBlockDevice = amiDetails.BlockDeviceMappings.filter(function (d) { return !!d.Ebs; })[0];
            if (!mainBlockDevice) return callback(new Error('Unable to detect main block device'));

            var params = {
                ImageId: ami.id,
                MinCount: 1,
                MaxCount: 1,
                InstanceType: options.type,
                KeyName: options.sshKey,
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
                        VolumeSize: options.size,
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

function terminateInstance(instanceId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof instanceId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        InstanceIds: [ instanceId ]
    };

    gEC2.terminateInstances(params, function (error) {
        if (error) return callback(error);

        callback();
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

function checkS3BucketAccess(bucket, callback) {
    assert.strictEqual(typeof gS3, 'object');
    assert.strictEqual(typeof bucket, 'string');
    assert.strictEqual(typeof callback, 'function');

    var TEST_OBJECT_KEY = 'cloudron-test-object';

    var params = {
        Bucket: bucket,
        Key: TEST_OBJECT_KEY,
        Body: 'testcontent'
    };

    gS3.putObject(params, function (error) {
        if (error) return callback(error);

        var params = {
            Bucket: bucket,
        };

        gS3.listObjects(params, function (error) {
            if (error) return callback(error);

            var params = {
                Bucket: bucket,
                Key: TEST_OBJECT_KEY
            };

            gS3.deleteObject(params, function (error) {
                if (error) return callback(error);

                callback(null);
            });
        });
    });
}

function getBackupUrl(bucket, prefix, backupId, callback) {
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

    callback(null, url);
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

function getInstanceDetails(ip, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        Filters: [
            {
                Name: 'network-interface.addresses.association.public-ip',
                Values: [ ip ]
            }
        ]
    };

    gEC2.describeInstances(params, function (error, result) {
        if (error) return callback(error);
        if (result.Reservations.length === 0) return callback('No such EC2 instance found for this domain');

        callback(null, result.Reservations[0].Instances[0]);
    });
}

function getVolumeDetails(volumeId, callback) {
    assert.strictEqual(typeof gEC2, 'object');
    assert.strictEqual(typeof volumeId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var params = {
        VolumeIds: [ volumeId ]
    };

    gEC2.describeVolumes(params, function (error, result) {
        if (error) return callback(error);

        callback(null, result.Volumes[0]);
    });
}

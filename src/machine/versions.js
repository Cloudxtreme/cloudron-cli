'use strict';

var assert = require('assert'),
    superagent = require('superagent');

exports = module.exports = {
    versionsUrl: 'https://s3.amazonaws.com/prod-cloudron-releases/versions.json',
    init: init,
    resolve: resolve,
    details: details
};

var gVersions = null;

function init(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gVersions) return callback();

    superagent.get(exports.versionsUrl).end(function (error, result) {
        if (error) return callback(error);
        if (result.statusCode !== 200) return callback(new Error('Unable to fetch versions file'));

        gVersions = result.body;

        callback();
    });
}

function resolve(version, callback) {
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    init(function (error) {
        if (error) return callback(error);

        // FIXME use semver to determine that
        if (version === 'latest') return callback(null, '0.15.0');
        if (!gVersions[version]) return callback(new Error('Unknown version'));

        callback(null, version);
    });
}

function details(version, callback) {
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    resolve(version, function (error) {
        if (error) return callback(error);

        // FIXME should be real
        gVersions[version].ami = 'ami-0035dc6f';
        gVersions[version].sourceTarballUrl = 'https://dev-cloudron-releases.s3.amazonaws.com/box-7d4905296664ecd69c801a60caaab9d10a409e83.tar.gz';

        callback(null, gVersions[version]);
    });
}

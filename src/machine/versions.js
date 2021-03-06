'use strict';

var assert = require('assert'),
    semver = require('semver'),
    superagent = require('superagent');

exports = module.exports = {
    versionsUrl: process.env.CLOUDRON_VERSIONS_URL || process.env.BOX_VERSIONS_URL || 'https://s3.amazonaws.com/prod-cloudron-releases/versions.json',
    init: init,
    resolve: resolve,
    details: details
};

var gVersions = null;

function init(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gVersions) return callback();

    superagent.get(exports.versionsUrl).end(function (error, result) {
        if (error && !error.response) return callback(error);
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

        var sortedVersions = Object.keys(gVersions).sort(semver.compare);

        if (version === 'latest') {
            // ignore prereleases
            var i = sortedVersions.length;
            do {
                version = sortedVersions[--i];
            } while (version.indexOf('-pre') !== -1);
        }

        if (!gVersions[version]) return callback(new Error('Unknown version'));

        callback(null, version);
    });
}

function details(version, callback) {
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    resolve(version, function (error) {
        if (error) return callback(error);

        callback(null, gVersions[version]);
    });
}

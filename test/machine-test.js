#!/usr/bin/env node

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var child_process = require('child_process'),
    expect = require('expect.js'),
    path = require('path'),
    util = require('util');

var cloudron = process.env.CLOUDRON;
var username = process.env.USERNAME;
var password = process.env.PASSWORD;
var sshKey = process.env.SSH_KEY;

var CLI = path.resolve(__dirname + '/../bin/machine.js');

function cli(args, options) {
    // https://github.com/nodejs/node-v0.x-archive/issues/9265
    options = options || { };
    args = util.isArray(args) ? args : args.match(/[^\s"]+|"([^"]+)"/g);
    args = args.map(function (e) { return e[0] === '"' ? e.slice(1, -1) : e; }); // remove the quotes

    console.log('cloudron ' + args.join(' '));

    try {
        var cp = child_process.spawnSync(CLI, args, { stdio: [ options.stdin || 'pipe', options.stdout || 'pipe', 'pipe' ], encoding: options.encoding || 'utf8' });
        return cp;
    } catch (e) {
        console.error(e);
        throw e;
    }
}

before(function (done) {
    if (!process.env.CLOUDRON) return done(new Error('CLOUDRON env var not set'));
    if (!process.env.USERNAME) return done(new Error('USERNAME env var not set'));
    if (!process.env.PASSWORD) return done(new Error('PASSWORD env var not set'));

    done();
});

after(function (done) {
    done();
});

describe('Backup', function () {
    it('can create with rest route', function (done) {
        var out = cli(util.format('backup create %s --username %s --password %s', cloudron, username, password));
        expect(out.stdout.indexOf('Backup successful')).to.not.be(-1);
        done();
    });

    it('can create using ssh', function (done) {
        if (!sshKey) {
            console.log('Skipping ssh test');
            return done();
        }

        var out = cli(util.format('backup create %s --ssh-key %s', cloudron, sshKey));
        expect(out.stdout.indexOf('Backup successful')).to.not.be(-1);
        done();
    });

    it('can list', function (done) {
        var out = cli(util.format('backup list %s --username %s --password %s', cloudron, username, password));

        var backupCount = out.stdout.split('\n').filter(function(l) { return l.match(/^backup_/); }).length;
        expect(backupCount).to.be.greaterThan(sshKey ? 1 : 0);

        done();
    });
});

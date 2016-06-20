#!/usr/bin/env node

/* global it:false */
/* global describe:false */
/* global before:false */
/* global xdescribe:false */
/* global after:false */

'use strict';

var child_process = require('child_process'),
    crypto = require('crypto'),
    expect = require('expect.js'),
    fs = require('fs'),
    path = require('path'),
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    util = require('util');

var cloudron = process.env.CLOUDRON;
var username = process.env.USERNAME;
var password = process.env.PASSWORD;
var applocation = 'loctest';
var app;

var CLI = path.resolve(__dirname + '/../bin/app.js');

function md5(file) {
    var data = fs.readFileSync(file);
    var hash = crypto.createHash('md5').update(data).digest('hex');
    return hash;
}

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

describe('Login', function () {
    it('can login', function (done) {
        var out = cli(util.format('login %s --username %s --password %s', cloudron, username, password));
        expect(out.stdout.indexOf('Login successful')).to.not.be(-1);
        done();
    });
});

describe('App install', function () {
    it('can install app', function () {
        console.log('Installing app, this can take a while');
        var out = cli('install --appstore-id com.hastebin.cloudronapp@0.4.0 --new --wait --location ' + applocation);
        expect(out.stdout).to.contain('App is installed');
    });
});

describe('Inspect', function () {
    it('can inspect app', function () {
        var inspect = JSON.parse(cli('inspect').stdout);
        app = inspect.apps.filter(function (a) { return a.location === applocation; })[0];
        expect(app).to.not.be(null);
    });
});

describe('Exec', function () {
    it('can execute a command and see stdout', function () {
        var out = cli(util.format('exec --app %s -- ls -l /app/code', app.id));
        expect(out.stdout).to.contain('total');
    });

    it('can execute a command and see stderr', function () {
        var out = cli(util.format('exec --app %s -- ls /blah', app.id));
        expect(out.stderr).to.contain('ls: cannot access');
    });

    it('can get binary file in stdout', function (done) {
        var outstream = fs.createWriteStream('/tmp/clitest.ls');
        outstream.on('open', function () { // execSync underlying stream needs an fd which is available only after open event
            cli(util.format('exec --app %s -- cat /bin/ls', app.id), { stdout: outstream, encoding: 'binary' });
            expect(md5('/tmp/clitest.ls')).to.contain('7a92ef62f96553224faece68289b4fc3');
            fs.unlinkSync('/tmp/clitest.ls');
            done();
        });
    });

    it('can pipe stdin to exec command', function (done) {
        var randomBytes = require('crypto').randomBytes(256);
        fs.writeFileSync('/tmp/randombytes', randomBytes);
        var randomBytesMd5 = crypto.createHash('md5').update(randomBytes).digest('hex');

        var instream = fs.createReadStream('/tmp/randombytes');
        instream.on('open', function () {
            cli(util.format('exec --app %s -- bash -c "cat - > /app/data/sauce"', app.id), { stdin: instream });
            var out = cli(util.format('exec --app %s md5sum /app/data/sauce', app.id));
            expect(out.stdout).to.contain(randomBytesMd5);
            done();
        });
    });
});

describe('Push', function () {
    var RANDOM_FILE = '/tmp/randombytes';

    it('can push a binary file', function () {
        var randomBytes = crypto.randomBytes(500);
        fs.writeFileSync(RANDOM_FILE, randomBytes);

        cli(util.format('push --app %s %s /tmp/push1', app.id, RANDOM_FILE));
        var out = cli(util.format('exec --app %s md5sum /tmp/push1', app.id));
        expect(out.stdout).to.contain(md5(RANDOM_FILE));
        fs.unlinkSync(RANDOM_FILE);
    });

    it('can push to directory', function () {
        var testFile = __dirname + '/test.js';
        cli(util.format('push --app %s %s /tmp/', app.id, testFile));
        var out = cli(util.format('exec --app %s md5sum /tmp/test.js', app.id));
        expect(out.stdout).to.contain(md5(testFile));
    });

    it('can push stdin', function (done) {
        var randomBytes = crypto.randomBytes(500);
        fs.writeFileSync(RANDOM_FILE, randomBytes);

        var istream = fs.createReadStream(RANDOM_FILE);
        istream.on('open', function () { // exec requires underlying fd
            cli(util.format('push --app %s - /run/testcopy.js', app.id), { stdin: istream });
            var out = cli(util.format('exec --app %s md5sum /run/testcopy.js', app.id));
            expect(out.stdout).to.contain(md5(RANDOM_FILE));
            fs.unlinkSync(RANDOM_FILE);
            done();
        });
    });

    it('can push a directory', function () {
        var testDir = __dirname, testFile = __dirname + '/test.js';
        cli(util.format('push --app %s %s /run', app.id, testDir));
        var out = cli(util.format('exec --app %s md5sum /run/' + path.basename(__dirname) + '/test.js', app.id));
        expect(out.stdout).to.contain(md5(testFile));
    });

    it('can push a large file', function () {
        child_process.execSync('dd if=/dev/urandom of=' + RANDOM_FILE + ' bs=10M count=1');
        cli(util.format('push --app %s %s /tmp/push1', app.id, RANDOM_FILE));
        var out = cli(util.format('exec --app %s md5sum /tmp/push1', app.id));
        expect(out.stdout).to.contain(md5(RANDOM_FILE));
        fs.unlinkSync(RANDOM_FILE);
    });
});

describe('Pull', function () {
    var RANDOM_FILE = '/tmp/randombytes';

    before(function () {
        var randomBytes = crypto.randomBytes(20000);
        fs.writeFileSync(RANDOM_FILE, randomBytes);

        cli(util.format('push --app %s /tmp/randombytes /tmp/randombytes', app.id));
    });

    after(function () {
        fs.unlinkSync(RANDOM_FILE);
    });

    it('can pull a binary file', function () {
        cli(util.format('pull --app %s /tmp/randombytes /tmp/pullfiletest', app.id));
        expect(md5('/tmp/pullfiletest')).to.be(md5('/tmp/randombytes'));
        fs.unlinkSync('/tmp/pullfiletest');
    });

    it('can pull a directory', function () {
        rimraf.sync('/tmp/pulldir');
        safe.fs.mkdirSync('/tmp/pulldir');
        cli(util.format('pull --app %s /app/code/ /tmp/pulldir', app.id));
        expect(fs.existsSync('/tmp/pulldir/README.md')).to.be.ok();
        expect(fs.existsSync('/tmp/pulldir/static/robots.txt')).to.be.ok();
        expect(fs.existsSync('/tmp/pulldir/.gitignore')).to.be.ok();
        expect(md5('/tmp/pulldir/node_modules/uglify-js/bin/uglifyjs')).to.be('e1e83d5253cf6dade0a830d874257c6f');
        rimraf.sync('/tmp/pulldir');
    });

    it('can pull to directory', function () {
        safe.fs.unlinkSync('/tmp/pulledreadme.md');
        cli(util.format('pull --app %s /app/code/README.md /tmp/pulledreadme.md', app.id));
        expect(md5('/tmp/pulledreadme.md')).to.be('562bca2ed9dbd1a11a66e7cf6f65bdb7');
        fs.unlinkSync('/tmp/pulledreadme.md');
    });

    it('can pull to stdout', function (done) {
        safe.fs.unlinkSync('/tmp/pullfiletest');
        var ostream = fs.createWriteStream('/tmp/pullfiletest');
        ostream.on('open', function () { // exec requires underlying fd
            cli(util.format('pull --app %s /tmp/randombytes -', app.id), { stdout: ostream });
            expect(md5('/tmp/pullfiletest')).to.be(md5('/tmp/randombytes'));
            fs.unlinkSync('/tmp/pullfiletest');
            done();
        });
    });
});

describe('Status', function () {
    it('can get status', function () {
        var out = cli('status --app ' + app.id);
        expect(out.stdout).to.contain('Run state:  running');
    });
});

describe('Uninstall', function () {
    it('can uninstall', function () {
        var out = cli('uninstall --app ' + app.id);
        expect(out.stdout).to.contain('successfully uninstalled');
    });
});

describe('Logout', function () {
    it('can logout', function () {
        console.log('Uninstalling app, this can take a while');
        var out = cli('logout');
        expect(out.stdout).to.contain('Logged out');
    });
});

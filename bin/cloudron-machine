#!/usr/bin/env node

'use strict';

require('../src/common.js');

var program = require('commander');

program
    .version(require('../package.json').version)
    .command('create', 'Creates a new Cloudron')
    .command('restore', 'Restores a Cloudron')
    .command('migrate', 'Migrates a Cloudron')
    .command('update', 'Upgrade or updates a Cloudron')
    .command('eventlog', 'Get Cloudron eventlog')
    .command('logs', 'Get Cloudron logs')
    .command('ssh', 'Get remote SSH connection')
    .command('backup', 'Manage Cloudron backups');

program.parse(process.argv);
